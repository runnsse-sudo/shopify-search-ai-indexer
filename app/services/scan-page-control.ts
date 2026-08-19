import type { BatchCounts } from "./scan-progress.ts";

export function scanPageFailureUpdate(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown scan page failure";
  return {
    status: "FAILED" as const,
    errorMessage: message.slice(0, 4000),
    errorsCount: { increment: 1 },
    batchToken: null,
    batchClaimedAt: null,
  };
}

export function scanPageProgressUpdate(endCursor: string | null, counts: BatchCounts) {
  return {
    cursor: endCursor,
    productsProcessed: { increment: counts.processed },
    productsIndexable: { increment: counts.indexable },
    productsNonIndexable: { increment: counts.nonIndexable },
    productsChanged: { increment: counts.changed },
    queueItemsCreated: { increment: counts.queued },
    errorsCount: { increment: counts.errors },
    batchToken: null,
    batchClaimedAt: null,
  };
}
