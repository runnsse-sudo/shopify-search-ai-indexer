export type PendingIntentIdentity = {
  shopId: string;
  shopifyProductGid: string;
  provider: string;
  action: string;
};

export function createPendingIntentKey(input: PendingIntentIdentity) {
  return [input.shopId, input.shopifyProductGid, input.provider, input.action].join("|");
}

export function pendingIntentRefresh(input: {
  url: string | null;
  reason: string;
  productIndexStateId?: string;
  now: Date;
}) {
  return {
    url: input.url,
    reason: input.reason,
    ...(input.productIndexStateId ? { productIndexStateId: input.productIndexStateId } : {}),
    nextAttemptAt: input.now,
    lastError: null,
  };
}

export function compactPendingIntent<T extends Record<string, unknown>>(
  existing: T | null,
  input: Parameters<typeof pendingIntentRefresh>[0],
) {
  return existing
    ? { item: { ...existing, ...pendingIntentRefresh(input) }, created: false as const }
    : { item: pendingIntentRefresh(input), created: true as const };
}

export async function acquirePendingIntentSlot<T>(input: {
  createSlot: () => Promise<boolean>;
  refreshSlot: () => Promise<boolean>;
  fetchSlot: () => Promise<T | null>;
  maxAttempts?: number;
}) {
  const maxAttempts = input.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const created = await input.createSlot();
    const refreshed = await input.refreshSlot();
    if (!refreshed) continue;
    const item = await input.fetchSlot();
    if (item) return { item, created, attempts: attempt };
  }
  throw new Error(`Unable to establish pending queue intent after ${maxAttempts} attempts`);
}

export function claimPendingTransition(now: Date) {
  return { status: "PROCESSING" as const, claimedAt: now, dedupeKey: null };
}

export function retryRaceSupersededTransition(error: string, now: Date) {
  return {
    status: "SKIPPED" as const,
    retryCount: { increment: 1 },
    lastError: `Superseded by newer pending intent after retry race: ${error}`.slice(0, 4000),
    claimedAt: null,
    completedAt: now,
    dedupeKey: null,
  };
}

export function processingFailureTransition(input: {
  retryCount: number;
  maxRetries: number;
  error: string;
  retryAt: Date;
  pendingIntentKey: string;
  hasPendingSuccessor: boolean;
  now: Date;
}) {
  const retryCount = input.retryCount + 1;
  const lastError = input.error.slice(0, 4000);
  if (retryCount >= input.maxRetries) {
    return {
      status: "FAILED" as const,
      retryCount,
      lastError,
      claimedAt: null,
      completedAt: input.now,
      dedupeKey: null,
    };
  }
  if (input.hasPendingSuccessor) {
    return {
      status: "SKIPPED" as const,
      retryCount,
      lastError: `Superseded by newer pending intent: ${lastError}`.slice(0, 4000),
      claimedAt: null,
      completedAt: input.now,
      dedupeKey: null,
    };
  }
  return {
    status: "PENDING" as const,
    retryCount,
    lastError,
    claimedAt: null,
    completedAt: null,
    dedupeKey: input.pendingIntentKey,
    nextAttemptAt: input.retryAt,
  };
}

export type ReconciliationItem = PendingIntentIdentity & {
  id: string;
  status: string;
  dedupeKey: string | null;
  url: string | null;
  createdAt: Date;
};

export function buildQueueReconciliationPlan(items: ReconciliationItem[]) {
  const pending = items.filter((item) => item.status === "PENDING");
  const groups = new Map<string, ReconciliationItem[]>();
  for (const item of pending) {
    const key = createPendingIntentKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const cancellations: Array<{ id: string; keeperId: string }> = [];
  const normalizations: Array<{ id: string; dedupeKey: string }> = [];
  let duplicateGroups = 0;
  let singleRowsToNormalize = 0;
  const invalidRows = pending.filter((item) => !item.url).length;
  for (const [dedupeKey, group] of groups) {
    const ordered = [...group].sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    );
    const keeper = ordered[0];
    if (ordered.length > 1) duplicateGroups += 1;
    for (const older of ordered.slice(1)) cancellations.push({ id: older.id, keeperId: keeper.id });
    if (keeper.dedupeKey !== dedupeKey) {
      normalizations.push({ id: keeper.id, dedupeKey });
      if (ordered.length === 1) singleRowsToNormalize += 1;
    }
  }
  return {
    pendingRowsFound: pending.length,
    pendingIntentGroups: groups.size,
    duplicateGroups,
    duplicateRowsToRemove: cancellations.length,
    singleRowsToNormalize,
    keepersToNormalize: normalizations.length,
    invalidRows,
    cancellations,
    normalizations,
    wouldMutate: cancellations.length + normalizations.length,
  };
}

export function assertQueueReconciliationCanApply(processingRowsFound: number) {
  if (processingRowsFound > 0) {
    throw new Error("Queue reconciliation APPLY requires zero PROCESSING rows");
  }
}

export function auditQueueInvariants(items: ReconciliationItem[]) {
  const pendingGroups = new Map<string, number>();
  let processingWithDedupeKey = 0;
  let pendingWithoutDedupeKey = 0;
  let terminalWithDedupeKey = 0;
  for (const item of items) {
    if (item.status === "PENDING") {
      const key = createPendingIntentKey(item);
      pendingGroups.set(key, (pendingGroups.get(key) ?? 0) + 1);
      if (!item.dedupeKey) pendingWithoutDedupeKey += 1;
    } else if (item.status === "PROCESSING") {
      if (item.dedupeKey) processingWithDedupeKey += 1;
    } else if (item.dedupeKey) {
      terminalWithDedupeKey += 1;
    }
  }
  return {
    duplicatePendingIntentGroups: [...pendingGroups.values()].filter((count) => count > 1).length,
    processingWithDedupeKey,
    pendingWithoutDedupeKey,
    terminalWithDedupeKey,
  };
}

export function applyQueueReconciliationPlan(
  items: ReconciliationItem[],
  plan: ReturnType<typeof buildQueueReconciliationPlan>,
  apply: boolean,
) {
  if (!apply) return items.map((item) => ({ ...item }));
  const cancelled = new Set(plan.cancellations.map((item) => item.id));
  const normalized = new Map(plan.normalizations.map((item) => [item.id, item.dedupeKey]));
  return items.map((item) => cancelled.has(item.id)
    ? { ...item, status: "CANCELLED", dedupeKey: null }
    : { ...item, dedupeKey: normalized.get(item.id) ?? item.dedupeKey });
}
