export type BatchCounts = {
  processed: number;
  indexable: number;
  nonIndexable: number;
  changed: number;
  queued: number;
  errors: number;
};

export function nextScanStatus(hasNextPage: boolean) {
  return hasNextPage ? "RUNNING" as const : "COMPLETED" as const;
}

export function initialScanActiveKey(shopId: string) {
  return `initial-scan:${shopId}`;
}

export function buildScanPageVariables(cursor: string | null, pageSize: number) {
  return { first: pageSize, after: cursor };
}

export function addBatchCounts(
  current: BatchCounts,
  batch: BatchCounts,
): BatchCounts {
  return {
    processed: current.processed + batch.processed,
    indexable: current.indexable + batch.indexable,
    nonIndexable: current.nonIndexable + batch.nonIndexable,
    changed: current.changed + batch.changed,
    queued: current.queued + batch.queued,
    errors: current.errors + batch.errors,
  };
}
