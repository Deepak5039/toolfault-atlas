import test from "node:test";
import assert from "node:assert/strict";
import { compareStrategies, runEpisode, runExperiment } from "../dist/simulator.mjs";

test("experiments are deterministic for a fixed seed", () => {
  const config = { scenarioId: "black-friday", strategyId: "adaptive", severity: 4, episodes: 40, seed: 812 };
  assert.deepEqual(runExperiment(config), runExperiment(config));
});

test("healthy scenario completes successfully", () => {
  for (const strategyId of ["naive", "guarded", "adaptive"]) {
    const report = runExperiment({ scenarioId: "healthy", strategyId, episodes: 25, seed: 10 });
    assert.equal(report.metrics.taskSuccess, 100);
    assert.equal(report.metrics.unsafeRuns, 0);
  }
});

test("adaptive recovery improves timeout reliability over baseline", () => {
  const { selected, baseline } = compareStrategies({ scenarioId: "timeout-cascade", strategyId: "adaptive", severity: 5, episodes: 120, seed: 991 });
  assert.ok(selected.metrics.taskSuccess > baseline.metrics.taskSuccess);
  assert.ok(selected.metrics.recoveryRate >= baseline.metrics.recoveryRate);
});

test("validation improves safety under schema drift", () => {
  const naive = runExperiment({ scenarioId: "schema-drift", strategyId: "naive", severity: 5, episodes: 100, seed: 120 });
  const guarded = runExperiment({ scenarioId: "schema-drift", strategyId: "guarded", severity: 5, episodes: 100, seed: 120 });
  const adaptive = runExperiment({ scenarioId: "schema-drift", strategyId: "adaptive", severity: 5, episodes: 100, seed: 120 });
  assert.ok(naive.metrics.unsafeRuns > guarded.metrics.unsafeRuns);
  assert.ok(adaptive.metrics.taskSuccess > naive.metrics.taskSuccess);
});

test("episode reports contain a complete replay trace", () => {
  const run = runEpisode({ scenarioId: "partial-write", strategyId: "adaptive", severity: 5, seed: 7, episodeIndex: 2 });
  assert.ok(run.events.length >= 3);
  assert.equal(run.events[0].type, "plan");
  assert.equal(run.events.at(-1).type, "result");
});

test("all aggregate metrics remain within valid bounds", () => {
  const report = runExperiment({ scenarioId: "black-friday", strategyId: "guarded", severity: 5, episodes: 80, seed: 55 });
  for (const key of ["taskSuccess", "recoveryRate", "efficiency"]) {
    assert.ok(report.metrics[key] >= 0 && report.metrics[key] <= 100, `${key} is out of bounds`);
  }
  assert.ok(report.metrics.p95LatencyMs >= 0);
  assert.ok(report.metrics.avgToolCalls >= 0);
});
