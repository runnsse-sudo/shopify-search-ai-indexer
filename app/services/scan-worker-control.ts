export type WorkerScanStatus =
  | "PENDING"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type WorkerStatusDecision = "continue" | "resume" | "stop";

export function parseBatchSize(value: string | undefined) {
  if (value === undefined || value.trim() === "") return 100;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

export function parseMaxBatches(value: string | undefined) {
  return parsePositiveInteger("SCAN_MAX_BATCHES", value, 1000);
}

export function parseInterBatchDelay(value: string | undefined) {
  if (value === undefined || value.trim() === "") return 500;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 60_000) {
    throw new Error("SCAN_INTER_BATCH_DELAY_MS must be an integer between 0 and 60000");
  }
  return parsed;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function decideWorkerAction(status: WorkerScanStatus): WorkerStatusDecision {
  if (status === "FAILED") return "resume";
  if (status === "PENDING" || status === "RUNNING") return "continue";
  return "stop";
}

export function resolveUnscopedEligibleRun(runIds: string[]) {
  if (runIds.length === 0) return { kind: "none" as const };
  if (runIds.length === 1) return { kind: "selected" as const, runId: runIds[0] };
  return { kind: "ambiguous" as const, count: runIds.length };
}

export function reachedWorkerSafetyCeiling(batchesExecuted: number, maxBatches: number) {
  return batchesExecuted >= maxBatches;
}

export function shouldRetryAuthentication(retriesUsed: number) {
  return retriesUsed < 1;
}
