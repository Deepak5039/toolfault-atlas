import { SCENARIOS, STRATEGIES, compareStrategies, getScenario, getStrategy } from "./simulator.mjs";

const DEFAULTS = { scenarioId: "timeout-cascade", strategyId: "adaptive", severity: 3, episodes: 50, seed: 2026 };
const state = { ...DEFAULTS };
let latestReport = null;
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const percent = (value) => `${Math.max(0, Math.min(100, value))}%`;
const formatLatency = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const scenarioId = params.get("scenario");
  const strategyId = params.get("strategy");
  if (SCENARIOS.some((item) => item.id === scenarioId)) state.scenarioId = scenarioId;
  if (STRATEGIES.some((item) => item.id === strategyId) && strategyId !== "naive") state.strategyId = strategyId;
  const severity = Number(params.get("severity"));
  const episodes = Number(params.get("episodes"));
  const seed = Number(params.get("seed"));
  if (severity >= 1 && severity <= 5) state.severity = severity;
  if ([25, 50, 100, 250].includes(episodes)) state.episodes = episodes;
  if (Number.isInteger(seed) && seed > 0) state.seed = seed;
}

function writeHash() {
  const params = new URLSearchParams({ scenario: state.scenarioId, strategy: state.strategyId, severity: state.severity, episodes: state.episodes, seed: state.seed });
  history.replaceState(null, "", `${location.pathname}#${params}`);
}

function renderControls() {
  $("#scenarioList").innerHTML = SCENARIOS.filter((item) => item.id !== "healthy").map((scenario) => `
    <button class="scenario-option ${scenario.id === state.scenarioId ? "active" : ""}" type="button" data-scenario="${scenario.id}" aria-pressed="${scenario.id === state.scenarioId}">
      <b>${scenario.glyph}</b><span>${scenario.name}</span><small>${scenario.short}</small>
    </button>
  `).join("");

  $("#strategyList").innerHTML = STRATEGIES.filter((item) => item.id !== "naive").map((strategy) => `
    <button class="strategy-option ${strategy.id === state.strategyId ? "active" : ""}" type="button" data-strategy="${strategy.id}" aria-pressed="${strategy.id === state.strategyId}">
      <i class="strategy-radio"></i><span><strong>${strategy.name}</strong><small>${strategy.id === "adaptive" ? "Validation · fallbacks · verified writes" : "Validation · retry · verified writes"}</small></span><em>${strategy.id === "adaptive" ? "MAX" : "MID"}</em>
    </button>
  `).join("");

  $("#severityInput").value = state.severity;
  $("#severityInput").style.setProperty("--range", `${(state.severity - 1) * 25}%`);
  $("#severityValue").textContent = `${state.severity} / 5`;
  $("#episodesInput").value = String(state.episodes);
  $("#seedValue").textContent = state.seed;
}

function deltaText(selected, baseline, higherIsBetter = true, unit = "pp") {
  const delta = selected - baseline;
  const isGood = higherIsBetter ? delta >= 0 : delta <= 0;
  const sign = delta > 0 ? "+" : "";
  return { text: `${sign}${delta}${unit}`, good: isGood };
}

function metricCard(label, value, hint, delta) {
  return `<div class="metric-card"><span>${label}</span><strong>${value}</strong><small class="delta ${delta.good ? "" : "negative"}">${delta.text} vs baseline</small><small> · ${hint}</small></div>`;
}

function renderMetrics(selected, baseline) {
  const successDelta = deltaText(selected.taskSuccess, baseline.taskSuccess);
  const recoveryDelta = deltaText(selected.recoveryRate, baseline.recoveryRate);
  const latencyDelta = deltaText(selected.p95LatencyMs, baseline.p95LatencyMs, false, "ms");
  const callDelta = { ...deltaText(Number(selected.avgToolCalls), Number(baseline.avgToolCalls), false, ""), text: `${(selected.avgToolCalls - baseline.avgToolCalls) > 0 ? "+" : ""}${(selected.avgToolCalls - baseline.avgToolCalls).toFixed(1)}` };
  const unsafeDelta = deltaText(selected.unsafeRuns, baseline.unsafeRuns, false, "");
  $("#metricsGrid").innerHTML = [
    metricCard("Task success", `${selected.taskSuccess}%`, "goal ≥ 90%", successDelta),
    metricCard("Fault recovery", `${selected.recoveryRate}%`, "faulted runs", recoveryDelta),
    metricCard("P95 latency", formatLatency(selected.p95LatencyMs), "end to end", latencyDelta),
    metricCard("Avg tool calls", selected.avgToolCalls, "per episode", callDelta),
    metricCard("Unsafe runs", selected.unsafeRuns, "silent failures", unsafeDelta)
  ].join("");
}

function comparisonRow(label, selectedValue, baselineValue, unit = "%", maxValue = 100, lowerIsBetter = false) {
  const selectedWidth = lowerIsBetter ? (1 - Math.min(selectedValue, maxValue) / maxValue) * 100 : selectedValue / maxValue * 100;
  const baselineWidth = lowerIsBetter ? (1 - Math.min(baselineValue, maxValue) / maxValue) * 100 : baselineValue / maxValue * 100;
  return `<div class="comparison-row"><div class="comparison-label"><strong>${label}</strong><span>${lowerIsBetter ? "lower is better" : "higher is better"}</span></div><div class="bar-pair">
    <div class="bar-line selected"><span>Selected</span><div class="bar-track"><i style="width:${percent(selectedWidth)}"></i></div><b>${selectedValue}${unit}</b></div>
    <div class="bar-line"><span>Naive</span><div class="bar-track"><i style="width:${percent(baselineWidth)}"></i></div><b>${baselineValue}${unit}</b></div>
  </div></div>`;
}

function renderComparison(selected, baseline) {
  const latencyMax = Math.max(selected.p95LatencyMs, baseline.p95LatencyMs, 1) * 1.15;
  $("#comparisonRows").innerHTML = [
    comparisonRow("Task success", selected.taskSuccess, baseline.taskSuccess),
    comparisonRow("Recovery rate", selected.recoveryRate, baseline.recoveryRate),
    comparisonRow("P95 latency", selected.p95LatencyMs, baseline.p95LatencyMs, "ms", latencyMax, true),
    comparisonRow("Tool efficiency", selected.efficiency, baseline.efficiency)
  ].join("");
  const gain = selected.taskSuccess - baseline.taskSuccess;
  $("#comparisonNote").innerHTML = gain > 0
    ? `<strong>Finding:</strong> recovery policy improved successful completion by ${gain} percentage points across the paired incident set.`
    : `<strong>Finding:</strong> this configuration adds overhead without improving success. Reduce severity or choose a failure-specific policy.`;
}

function renderTrace(run) {
  $("#traceOutcome").textContent = run.success ? `RECOVERED · EP ${run.episodeIndex + 1}` : `FAILED · EP ${run.episodeIndex + 1}`;
  $("#traceList").innerHTML = run.events.map((event) => `
    <div class="trace-event ${event.status}">
      <span class="trace-time">+${event.timeMs}ms</span>
      <i class="trace-dot"></i>
      <div class="trace-copy"><strong>${event.label}${event.attempt ? `<span class="trace-chip">attempt ${event.attempt}</span>` : ""}</strong><p>${event.detail}</p></div>
    </div>
  `).join("");
}

function renderReport(report) {
  latestReport = report;
  const scenario = getScenario(state.scenarioId);
  const strategy = getStrategy(state.strategyId);
  const { selected, baseline } = report;
  $("#summaryScenario").textContent = scenario.name;
  $("#summaryStrategy").textContent = strategy.name;
  $("#summaryDescription").textContent = scenario.description;
  $("#comparisonEpisodes").textContent = `${state.episodes} paired runs`;
  const resilient = selected.metrics.taskSuccess >= 85 && selected.metrics.unsafeRuns === 0;
  $("#verdictText").textContent = resilient ? "RESILIENT" : selected.metrics.taskSuccess >= 65 ? "DEGRADED" : "FRAGILE";
  $("#verdictBlock").classList.toggle("warning", !resilient);
  renderMetrics(selected.metrics, baseline.metrics);
  renderComparison(selected.metrics, baseline.metrics);
  renderTrace(selected.representative);
}

function run({ animate = true } = {}) {
  writeHash();
  const button = $("#runExperiment");
  const status = $("#runStatus");
  if (animate) {
    button.classList.add("running");
    button.disabled = true;
    status.textContent = "RUNNING PAIRED EPISODES…";
  }
  const execute = () => {
    const report = compareStrategies({ ...state });
    renderReport(report);
    button.classList.remove("running");
    button.disabled = false;
    status.textContent = `LATEST RUN · ${new Date().toISOString().slice(11,19)} UTC`;
    if (animate) showToast(`${state.episodes * 2} deterministic episodes completed.`);
  };
  if (animate) setTimeout(execute, 620); else execute();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function exportReport() {
  if (!latestReport) return;
  const payload = {
    project: "ToolFault Atlas",
    generatedAt: new Date().toISOString(),
    methodology: "Deterministic paired simulation; selected and naive strategies use reproducible seeded episodes.",
    ...latestReport
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `toolfault-${state.scenarioId}-${state.seed}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Experiment report downloaded.");
}

document.addEventListener("click", (event) => {
  const scenario = event.target.closest("[data-scenario]");
  const strategy = event.target.closest("[data-strategy]");
  if (scenario) { state.scenarioId = scenario.dataset.scenario; renderControls(); }
  if (strategy) { state.strategyId = strategy.dataset.strategy; renderControls(); }
});

$("#severityInput").addEventListener("input", (event) => { state.severity = Number(event.target.value); renderControls(); });
$("#episodesInput").addEventListener("change", (event) => { state.episodes = Number(event.target.value); });
$("#newSeed").addEventListener("click", () => { state.seed = Math.floor(1000 + Math.random() * 8999); renderControls(); showToast("New reproducible seed generated."); });
$("#runExperiment").addEventListener("click", () => run());
$("#resetConfig").addEventListener("click", () => { Object.assign(state, DEFAULTS); renderControls(); run(); });
$("#loadHardMode").addEventListener("click", () => { Object.assign(state, { scenarioId: "black-friday", strategyId: "adaptive", severity: 5, episodes: 100, seed: 9001 }); renderControls(); run({ animate: false }); document.querySelector("#lab").scrollIntoView({ behavior: "smooth" }); showToast("Compound incident loaded."); });
$("#exportReport").addEventListener("click", exportReport);
$("#copyLink").addEventListener("click", async () => {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); showToast("Reproducible setup link copied."); }
  catch { showToast("Copy unavailable—use the current page URL."); }
});

readHash();
renderControls();
run({ animate: false });
