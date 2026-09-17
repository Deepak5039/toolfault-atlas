const TOOL_STEPS = [
  { id: "customer_lookup", label: "Customer lookup", baseLatency: 110, critical: true, kind: "read" },
  { id: "order_api", label: "Order API", baseLatency: 180, critical: true, kind: "read" },
  { id: "policy_search", label: "Policy search", baseLatency: 140, critical: true, kind: "read" },
  { id: "refund_api", label: "Refund API", baseLatency: 240, critical: true, kind: "write" },
  { id: "refund_status", label: "Refund verification", baseLatency: 120, critical: true, kind: "read" }
];

export const SCENARIOS = [
  {
    id: "healthy",
    name: "Healthy baseline",
    short: "No injected faults",
    glyph: "OK",
    description: "A control run with ordinary network jitter and valid tool responses.",
    faults: []
  },
  {
    id: "timeout-cascade",
    name: "Timeout cascade",
    short: "Slow dependencies",
    glyph: "TO",
    description: "Customer and order services intermittently exceed the agent's deadline.",
    faults: [
      { tools: ["customer_lookup", "order_api"], type: "timeout", baseRate: 0.16 }
    ]
  },
  {
    id: "rate-limit-burst",
    name: "Rate-limit burst",
    short: "HTTP 429 pressure",
    glyph: "429",
    description: "Shared services reject bursts, rewarding backoff instead of immediate retries.",
    faults: [
      { tools: ["policy_search", "refund_api"], type: "rate_limit", baseRate: 0.18 }
    ]
  },
  {
    id: "schema-drift",
    name: "Schema drift",
    short: "Silent contract change",
    glyph: "{}",
    description: "The order service renames a required field without changing its success status.",
    faults: [
      { tools: ["order_api"], type: "schema_drift", baseRate: 0.28 }
    ]
  },
  {
    id: "stale-evidence",
    name: "Stale evidence",
    short: "Old policy data",
    glyph: "ST",
    description: "Policy search returns an expired refund rule that appears structurally valid.",
    faults: [
      { tools: ["policy_search"], type: "stale_data", baseRate: 0.32 }
    ]
  },
  {
    id: "partial-write",
    name: "Partial write",
    short: "Ambiguous side effect",
    glyph: "PW",
    description: "The refund is committed, but the acknowledgement is lost before reaching the agent.",
    faults: [
      { tools: ["refund_api"], type: "partial_write", baseRate: 0.24 }
    ]
  },
  {
    id: "black-friday",
    name: "Black Friday mix",
    short: "Compound incident",
    glyph: "BF",
    description: "Timeouts, rate limits, stale data, and partial writes arrive in the same run.",
    faults: [
      { tools: ["customer_lookup", "order_api"], type: "timeout", baseRate: 0.08 },
      { tools: ["policy_search", "refund_api"], type: "rate_limit", baseRate: 0.08 },
      { tools: ["policy_search"], type: "stale_data", baseRate: 0.08 },
      { tools: ["refund_api"], type: "partial_write", baseRate: 0.07 }
    ]
  }
];

export const STRATEGIES = [
  {
    id: "naive",
    name: "Naive agent",
    description: "Single attempt, trusts successful responses, no side-effect verification.",
    retries: 0,
    validates: false,
    verifiesWrites: false,
    usesFallback: false,
    backoffMs: 0,
    circuitThreshold: Infinity
  },
  {
    id: "guarded",
    name: "Guarded retry",
    description: "Bounded retries, schema checks, exponential backoff, and write verification.",
    retries: 2,
    validates: true,
    verifiesWrites: true,
    usesFallback: false,
    backoffMs: 180,
    circuitThreshold: 3
  },
  {
    id: "adaptive",
    name: "Adaptive recovery",
    description: "Fault-aware retries, validation, verified writes, fallbacks, and early circuit breaking.",
    retries: 3,
    validates: true,
    verifiesWrites: true,
    usesFallback: true,
    backoffMs: 140,
    circuitThreshold: 2
  }
];

const FAULT_META = {
  timeout: { label: "Deadline exceeded", retryable: true, latency: 1650 },
  rate_limit: { label: "HTTP 429 rate limited", retryable: true, latency: 90 },
  schema_drift: { label: "Response contract drifted", retryable: false, latency: 25 },
  stale_data: { label: "Stale policy evidence", retryable: false, latency: 15 },
  partial_write: { label: "Acknowledgement lost after write", retryable: false, latency: 900 }
};

function hashSeed(input) {
  let hash = 2166136261;
  for (const char of String(input)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function faultForStep(stepId, scenario, severity, random) {
  const candidates = scenario.faults.filter((fault) => fault.tools.includes(stepId));
  for (const candidate of candidates) {
    const severityMultiplier = 0.45 + severity * 0.22;
    if (random() < Math.min(0.82, candidate.baseRate * severityMultiplier)) return candidate.type;
  }
  return null;
}

function canDetect(faultType, strategy) {
  if (["timeout", "rate_limit"].includes(faultType)) return true;
  if (["schema_drift", "stale_data"].includes(faultType)) return strategy.validates;
  if (faultType === "partial_write") return strategy.verifiesWrites;
  return false;
}

function canFallback(faultType, step, strategy) {
  if (!strategy.usesFallback || step.kind === "write") return false;
  return ["timeout", "rate_limit", "schema_drift", "stale_data"].includes(faultType);
}

export function runEpisode({ scenarioId, strategyId, severity = 3, seed = 42, episodeIndex = 0 }) {
  const scenario = SCENARIOS.find((item) => item.id === scenarioId) || SCENARIOS[0];
  const strategy = STRATEGIES.find((item) => item.id === strategyId) || STRATEGIES[0];
  const eventRandom = (...parts) => seededRandom(hashSeed(`${seed}:${scenario.id}:${episodeIndex}:${parts.join(":")}`));
  const events = [];
  let clock = 0;
  let calls = 0;
  let faults = 0;
  let recoveredFaults = 0;
  let unrecovered = 0;
  let circuitFailures = 0;

  events.push({ timeMs: clock, type: "plan", status: "info", label: "Agent plan", detail: "Validate the customer, order, policy, refund write, and final state." });

  for (const step of TOOL_STEPS) {
    let stepPassed = false;
    let usedFallback = false;
    let attempt = 0;

    if (circuitFailures >= strategy.circuitThreshold && strategy.usesFallback && step.kind === "read") {
      clock += 45;
      usedFallback = true;
      stepPassed = true;
      events.push({ timeMs: clock, type: "circuit", status: "recovered", tool: step.id, label: `${step.label}: fallback`, detail: "Circuit open; served a validated fallback instead of calling the degraded tool." });
    }

    while (!stepPassed && !usedFallback && attempt <= strategy.retries) {
      attempt += 1;
      calls += 1;
      const jitterRandom = eventRandom(step.id, attempt, "jitter");
      const faultRandom = eventRandom(step.id, attempt, "fault");
      const jitter = Math.round((jitterRandom() - 0.5) * step.baseLatency * 0.4);
      const faultType = faultForStep(step.id, scenario, severity, faultRandom);
      const baseLatency = Math.max(20, step.baseLatency + jitter);

      if (!faultType) {
        clock += baseLatency;
        stepPassed = true;
        circuitFailures = Math.max(0, circuitFailures - 1);
        events.push({ timeMs: clock, type: "tool", status: attempt > 1 ? "recovered" : "success", tool: step.id, attempt, latencyMs: baseLatency, label: `${step.label}: success`, detail: attempt > 1 ? `Recovered on attempt ${attempt}.` : "Valid response received." });
        break;
      }

      faults += 1;
      const meta = FAULT_META[faultType];
      const detected = canDetect(faultType, strategy);
      clock += baseLatency + meta.latency;

      if (!detected) {
        const silentFailure = ["schema_drift", "stale_data"].includes(faultType);
        stepPassed = silentFailure;
        if (silentFailure) unrecovered += 1;
        else unrecovered += 1;
        events.push({ timeMs: clock, type: "fault", status: silentFailure ? "unsafe" : "failed", tool: step.id, attempt, latencyMs: baseLatency + meta.latency, fault: faultType, label: `${step.label}: ${meta.label}`, detail: silentFailure ? "The response looked successful, so the bad data propagated." : "The agent could not determine whether the write completed." });
        break;
      }

      circuitFailures += 1;
      events.push({ timeMs: clock, type: "fault", status: "failed", tool: step.id, attempt, latencyMs: baseLatency + meta.latency, fault: faultType, label: `${step.label}: ${meta.label}`, detail: `Detected by ${faultType === "partial_write" ? "write verification" : faultType.includes("data") || faultType.includes("schema") ? "response validation" : "transport status"}.` });

      if (faultType === "partial_write" && strategy.verifiesWrites) {
        clock += 130;
        calls += 1;
        stepPassed = true;
        recoveredFaults += 1;
        events.push({ timeMs: clock, type: "verify", status: "recovered", tool: step.id, label: "Idempotency check: refund exists", detail: "Recovered without issuing a duplicate refund." });
        break;
      }

      if (canFallback(faultType, step, strategy) && (attempt > 1 || !meta.retryable)) {
        const fallbackRandom = eventRandom(step.id, attempt, "fallback");
        clock += 70;
        if (fallbackRandom() < 0.9) {
          stepPassed = true;
          usedFallback = true;
          recoveredFaults += 1;
          events.push({ timeMs: clock, type: "fallback", status: "recovered", tool: step.id, label: `${step.label}: fallback accepted`, detail: "Switched to a validated secondary source." });
          break;
        }
        events.push({ timeMs: clock, type: "fallback", status: "failed", tool: step.id, label: `${step.label}: fallback unavailable`, detail: "The secondary source did not pass its health check." });
      }

      if (meta.retryable && attempt <= strategy.retries) {
        const backoffRandom = eventRandom(step.id, attempt, "backoff");
        const backoff = Math.round(strategy.backoffMs * Math.pow(1.7, attempt - 1) + backoffRandom() * 80);
        clock += backoff;
        events.push({ timeMs: clock, type: "backoff", status: "info", tool: step.id, label: `Backoff ${backoff} ms`, detail: `Retry ${attempt + 1} scheduled with jitter.` });
        continue;
      }

      unrecovered += 1;
      break;
    }

    if (!stepPassed && step.critical) {
      events.push({ timeMs: clock, type: "stop", status: "failed", label: "Workflow stopped safely", detail: `Critical step “${step.label}” did not recover.` });
      break;
    }
  }

  const unsafe = events.some((event) => event.status === "unsafe");
  const stopped = events.some((event) => event.type === "stop");
  const success = !unsafe && !stopped && unrecovered === 0;
  if (success && faults > 0) recoveredFaults = Math.max(recoveredFaults, 1);
  events.push({ timeMs: clock, type: "result", status: success ? "success" : "failed", label: success ? "Task completed reliably" : unsafe ? "Task completed with unsafe evidence" : "Task failed", detail: `${calls} tool calls · ${clock} ms simulated latency` });

  return {
    episodeIndex,
    success,
    hadFault: faults > 0,
    recovered: success && faults > 0,
    unsafe,
    calls,
    faults,
    recoveredFaults,
    unrecovered,
    latencyMs: clock,
    estimatedCost: Number((calls * 0.00082 + events.length * 0.00005).toFixed(5)),
    events
  };
}

export function runExperiment({ scenarioId = "timeout-cascade", strategyId = "adaptive", severity = 3, episodes = 50, seed = 2026 } = {}) {
  const runs = Array.from({ length: episodes }, (_, episodeIndex) => runEpisode({ scenarioId, strategyId, severity, seed, episodeIndex }));
  const successful = runs.filter((run) => run.success).length;
  const faulted = runs.filter((run) => run.hadFault);
  const recovered = faulted.filter((run) => run.recovered).length;
  const totalCalls = runs.reduce((sum, run) => sum + run.calls, 0);
  const report = {
    config: { scenarioId, strategyId, severity, episodes, seed },
    metrics: {
      taskSuccess: Math.round((successful / episodes) * 100),
      recoveryRate: faulted.length ? Math.round((recovered / faulted.length) * 100) : 100,
      p95LatencyMs: percentile(runs.map((run) => run.latencyMs), 0.95),
      avgToolCalls: Number((totalCalls / episodes).toFixed(1)),
      efficiency: Math.max(0, Math.round((5 / Math.max(5, totalCalls / episodes)) * 100)),
      totalFaults: runs.reduce((sum, run) => sum + run.faults, 0),
      unsafeRuns: runs.filter((run) => run.unsafe).length,
      estimatedCost: Number(runs.reduce((sum, run) => sum + run.estimatedCost, 0).toFixed(3))
    },
    representative: runs.find((run) => run.recovered) || runs.find((run) => run.hadFault) || runs[0],
    runs
  };
  return report;
}

export function compareStrategies(config) {
  const selected = runExperiment(config);
  const baseline = runExperiment({ ...config, strategyId: "naive" });
  return { selected, baseline };
}

export function getScenario(id) {
  return SCENARIOS.find((item) => item.id === id) || SCENARIOS[0];
}

export function getStrategy(id) {
  return STRATEGIES.find((item) => item.id === id) || STRATEGIES[0];
}
