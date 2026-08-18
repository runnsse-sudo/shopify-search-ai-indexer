import assert from "node:assert/strict";
import test from "node:test";
import {
  decideWorkerAction,
  parseBatchSize,
  parseInterBatchDelay,
  parseMaxBatches,
  reachedWorkerSafetyCeiling,
  resolveUnscopedEligibleRun,
} from "../app/services/scan-worker-control.ts";

test("batch size defaults to 100 and clamps to the supported range", () => {
  assert.equal(parseBatchSize(undefined), 100);
  assert.equal(parseBatchSize("0"), 1);
  assert.equal(parseBatchSize("250"), 100);
  assert.equal(parseBatchSize("42"), 42);
});

test("max batches defaults and rejects invalid values", () => {
  assert.equal(parseMaxBatches(undefined), 1000);
  assert.equal(parseMaxBatches("25"), 25);
  assert.throws(() => parseMaxBatches("0"), /positive integer/);
  assert.throws(() => parseMaxBatches("1.5"), /positive integer/);
  assert.throws(() => parseMaxBatches("invalid"), /positive integer/);
});

test("inter-batch delay accepts zero and validates its upper bound", () => {
  assert.equal(parseInterBatchDelay(undefined), 500);
  assert.equal(parseInterBatchDelay("0"), 0);
  assert.equal(parseInterBatchDelay("60000"), 60_000);
  assert.throws(() => parseInterBatchDelay("60001"), /between 0 and 60000/);
});

test("worker status decisions preserve paused and terminal runs", () => {
  assert.equal(decideWorkerAction("PENDING"), "continue");
  assert.equal(decideWorkerAction("RUNNING"), "continue");
  assert.equal(decideWorkerAction("FAILED"), "resume");
  assert.equal(decideWorkerAction("PAUSED"), "stop");
  assert.equal(decideWorkerAction("COMPLETED"), "stop");
  assert.equal(decideWorkerAction("CANCELLED"), "stop");
});

test("worker safety ceiling stops without changing scan state", () => {
  assert.equal(reachedWorkerSafetyCeiling(9, 10), false);
  assert.equal(reachedWorkerSafetyCeiling(10, 10), true);
});

test("unscoped selection is a clean no-op with zero eligible runs", () => {
  assert.deepEqual(resolveUnscopedEligibleRun([]), { kind: "none" });
});

test("unscoped selection fails safely when multiple runs are eligible", () => {
  assert.deepEqual(resolveUnscopedEligibleRun(["run-1", "run-2"]), { kind: "ambiguous", count: 2 });
  assert.deepEqual(resolveUnscopedEligibleRun(["run-1"]), { kind: "selected", runId: "run-1" });
});
