export type StaleSnapshotReason =
  | "PRODUCT_ALREADY_DELETED"
  | "OLDER_SHOPIFY_UPDATED_AT"
  | "OLDER_EQUAL_VERSION_SNAPSHOT"
  | "AMBIGUOUS_EQUAL_VERSION_SNAPSHOT";

export type SnapshotOrderDecision =
  | { accept: true; staleReason: null }
  | { accept: false; staleReason: StaleSnapshotReason };

export function parseShopifyUpdatedAt(value: string): Date {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid Shopify product updatedAt: ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function decideProductSnapshotOrder(input: {
  existing: {
    deletedAt: Date | null;
    shopifyUpdatedAt: Date | null;
    lastDetectedAt: Date;
    contentHash: string | null;
  } | null;
  incomingShopifyUpdatedAt: Date;
  incomingSnapshotObservedAt: Date;
  incomingContentHash: string;
}): SnapshotOrderDecision {
  const existing = input.existing;
  if (!existing) return { accept: true, staleReason: null };
  if (existing.deletedAt) return { accept: false, staleReason: "PRODUCT_ALREADY_DELETED" };
  if (!existing.shopifyUpdatedAt) return { accept: true, staleReason: null };

  const versionComparison = input.incomingShopifyUpdatedAt.getTime() - existing.shopifyUpdatedAt.getTime();
  if (versionComparison < 0) return { accept: false, staleReason: "OLDER_SHOPIFY_UPDATED_AT" };
  if (versionComparison > 0) return { accept: true, staleReason: null };

  const observationComparison = input.incomingSnapshotObservedAt.getTime() - existing.lastDetectedAt.getTime();
  if (observationComparison < 0) return { accept: false, staleReason: "OLDER_EQUAL_VERSION_SNAPSHOT" };
  if (observationComparison > 0) return { accept: true, staleReason: null };
  if (input.incomingContentHash === existing.contentHash) return { accept: true, staleReason: null };
  return { accept: false, staleReason: "AMBIGUOUS_EQUAL_VERSION_SNAPSHOT" };
}

export function staleScanBookkeepingUpdate(scanRunId?: string) {
  return scanRunId ? { lastSeenScanRunId: scanRunId } : {};
}

export function staleDetectionResult(indexabilityState: string) {
  return { changed: false, queued: false, stale: true as const, indexabilityState };
}
