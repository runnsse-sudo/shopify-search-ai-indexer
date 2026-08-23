import type { IndexProvider, Prisma } from "@prisma/client";
import {
  claimPendingTransition,
  createPendingIntentKey,
  normalizeRecoveryLimit,
  ownsProcessingClaim,
  processingCompletionTransition,
  processingFailureTransition,
  processingLeaseRecoveryTransition,
  resolveProcessingLeaseBefore,
  retryRaceSupersededTransition,
} from "./index-queue-intent.ts";

type QueueClient = { indexQueueItem: Prisma.TransactionClient["indexQueueItem"] };
type RunTransaction = <T>(operation: (tx: QueueClient) => Promise<T>) => Promise<T>;

export async function claimNextWithClient(
  tx: QueueClient,
  provider: IndexProvider,
  now: () => Date = () => new Date(),
  shopId?: string,
) {
  const item = await tx.indexQueueItem.findFirst({
    where: { provider, status: "PENDING", nextAttemptAt: { lte: now() }, ...(shopId ? { shopId } : {}) },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
  });
  if (!item) return null;
  const claimedAt = now();
  const claimed = await tx.indexQueueItem.updateMany({
    where: { id: item.id, status: "PENDING" },
    data: claimPendingTransition(claimedAt),
  });
  if (claimed.count === 0) return null;
  const result = await tx.indexQueueItem.findUniqueOrThrow({ where: { id: item.id } });
  if (!ownsProcessingClaim(result, item.id, claimedAt)) {
    throw new Error(`Claim ownership token was not preserved for queue item ${item.id}`);
  }
  return result;
}

export async function markCompletedWithClient(
  client: QueueClient,
  id: string,
  expectedClaimedAt: Date,
  now: () => Date = () => new Date(),
) {
  const completedAt = now();
  const updated = await client.indexQueueItem.updateMany({
    where: { id, status: "PROCESSING", claimedAt: expectedClaimedAt },
    data: processingCompletionTransition(completedAt),
  });
  if (updated.count === 0) return { outcome: "ownership_lost" as const, item: null };
  const item = await client.indexQueueItem.findUniqueOrThrow({ where: { id } });
  return { outcome: "completed" as const, item };
}

export async function markFailedWithClient(input: {
  client: QueueClient;
  runTransaction: RunTransaction;
  isUniqueConstraintError: (error: unknown) => boolean;
  id: string;
  expectedClaimedAt: Date;
  error: string;
  retryAt?: Date;
  now?: () => Date;
  terminal?: boolean;
}) {
  const now = input.now ?? (() => new Date());
  try {
    return await input.runTransaction(async (tx) => {
      const item = await tx.indexQueueItem.findUnique({ where: { id: input.id } });
      if (!item || !ownsProcessingClaim(item, input.id, input.expectedClaimedAt)) {
        return { outcome: "ownership_lost" as const, item };
      }
      const pendingIntentKey = createPendingIntentKey(item);
      const successor = await tx.indexQueueItem.findUnique({ where: { dedupeKey: pendingIntentKey } });
      const retryCount = item.retryCount + 1;
      const transition = processingFailureTransition({
        retryCount: item.retryCount,
        maxRetries: item.maxRetries,
        error: input.error,
        retryAt: input.retryAt ?? new Date(now().getTime() + 60_000 * 2 ** Math.min(retryCount, 8)),
        pendingIntentKey,
        hasPendingSuccessor: Boolean(successor && successor.id !== item.id),
        now: now(),
        terminal: input.terminal,
      });
      const updated = await tx.indexQueueItem.updateMany({
        where: { id: input.id, status: "PROCESSING", claimedAt: input.expectedClaimedAt },
        data: transition,
      });
      if (updated.count === 0) return { outcome: "ownership_lost" as const, item: null };
      const result = await tx.indexQueueItem.findUniqueOrThrow({ where: { id: input.id } });
      return { outcome: "updated" as const, item: result };
    });
  } catch (caught) {
    if (!input.isUniqueConstraintError(caught)) throw caught;
    const skipped = await input.client.indexQueueItem.updateMany({
      where: { id: input.id, status: "PROCESSING", claimedAt: input.expectedClaimedAt },
      data: retryRaceSupersededTransition(input.error, now()),
    });
    if (skipped.count === 0) return { outcome: "ownership_lost" as const, item: null };
    const item = await input.client.indexQueueItem.findUniqueOrThrow({ where: { id: input.id } });
    return { outcome: "updated" as const, item };
  }
}

export async function recoverExpiredProcessingWithClient(input: {
  client: QueueClient;
  runTransaction: RunTransaction;
  isUniqueConstraintError: (error: unknown) => boolean;
  provider: IndexProvider;
  leaseBefore?: Date;
  leaseDurationMs?: number;
  limit?: number;
  now?: () => Date;
  shopId?: string;
}) {
  const now = input.now ?? (() => new Date());
  const limit = normalizeRecoveryLimit(input.limit);
  const leaseBefore = resolveProcessingLeaseBefore({ ...input, now: now() });
  const candidates = await input.client.indexQueueItem.findMany({
    where: { provider: input.provider, status: "PROCESSING", claimedAt: { lt: leaseBefore }, ...(input.shopId ? { shopId: input.shopId } : {}) },
    orderBy: [{ claimedAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  let requeued = 0;
  let skipped = 0;
  let ownershipLost = 0;
  for (const candidate of candidates) {
    if (!candidate.claimedAt) continue;
    const staleClaimedAt = candidate.claimedAt;
    try {
      const outcome = await input.runTransaction(async (tx) => {
        const current = await tx.indexQueueItem.findUnique({ where: { id: candidate.id } });
        if (!current || !ownsProcessingClaim(current, candidate.id, staleClaimedAt)) return "ownership_lost" as const;
        const pendingIntentKey = createPendingIntentKey(current);
        const successor = await tx.indexQueueItem.findUnique({ where: { dedupeKey: pendingIntentKey } });
        const transition = processingLeaseRecoveryTransition({
          hasPendingSuccessor: Boolean(successor && successor.id !== current.id),
          pendingIntentKey,
          now: now(),
          nextAttemptAt: now(),
        });
        const updated = await tx.indexQueueItem.updateMany({
          where: { id: current.id, status: "PROCESSING", claimedAt: staleClaimedAt },
          data: transition,
        });
        if (updated.count === 0) return "ownership_lost" as const;
        return transition.status === "PENDING" ? "requeued" as const : "skipped" as const;
      });
      if (outcome === "requeued") requeued += 1;
      else if (outcome === "skipped") skipped += 1;
      else ownershipLost += 1;
    } catch (caught) {
      if (!input.isUniqueConstraintError(caught)) throw caught;
      const result = await input.client.indexQueueItem.updateMany({
        where: { id: candidate.id, status: "PROCESSING", claimedAt: staleClaimedAt },
        data: {
          status: "SKIPPED",
          claimedAt: null,
          dedupeKey: null,
          completedAt: now(),
          lastError: "Expired processing lease superseded during dedupe restore race",
        },
      });
      if (result.count === 1) skipped += 1;
      else ownershipLost += 1;
    }
  }
  return { candidates: candidates.length, requeued, skipped, ownershipLost };
}
