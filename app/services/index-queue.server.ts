import { Prisma, type IndexProvider, type IndexQueueAction } from "@prisma/client";
import prisma from "../db.server";
import {
  acquirePendingIntentSlot,
  createPendingIntentKey,
  claimPendingTransition,
  pendingIntentRefresh,
  processingFailureTransition,
  retryRaceSupersededTransition,
} from "./index-queue-intent";

export type EnqueueProductInput = {
  shopId: string;
  productIndexStateId?: string;
  shopifyProductGid: string;
  url: string | null;
  reason: string;
  provider?: IndexProvider;
  action?: IndexQueueAction;
};

export async function enqueueProductWithClient(
  tx: Prisma.TransactionClient,
  input: EnqueueProductInput,
) {
  const provider = input.provider ?? "INTERNAL";
  const action = input.action ?? "INDEX";
  const dedupeKey = createPendingIntentKey({ ...input, provider, action });
  const now = new Date();
  const result = await acquirePendingIntentSlot({
    maxAttempts: 3,
    createSlot: async () => {
      const inserted = await tx.indexQueueItem.createMany({
        data: [{ ...input, provider, action, dedupeKey, nextAttemptAt: now }],
        skipDuplicates: true,
      });
      return inserted.count === 1;
    },
    refreshSlot: async () => {
      const refreshed = await tx.indexQueueItem.updateMany({
        where: { dedupeKey, status: "PENDING" },
        data: pendingIntentRefresh({ ...input, now }),
      });
      return refreshed.count === 1;
    },
    fetchSlot: () => tx.indexQueueItem.findFirst({
      where: { dedupeKey, status: "PENDING" },
    }),
  });
  return { item: result.item, created: result.created };
}

export async function enqueueProduct(input: EnqueueProductInput) {
  return prisma.$transaction((tx) => enqueueProductWithClient(tx, input));
}

export async function claimNext(provider: IndexProvider = "INTERNAL") {
  return prisma.$transaction(async (tx) => {
    const item = await tx.indexQueueItem.findFirst({
      where: { provider, status: "PENDING", nextAttemptAt: { lte: new Date() } },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    });
    if (!item) return null;
    const claimed = await tx.indexQueueItem.updateMany({
      where: { id: item.id, status: "PENDING" },
      data: claimPendingTransition(new Date()),
    });
    if (claimed.count === 0) return null;
    return tx.indexQueueItem.findUniqueOrThrow({ where: { id: item.id } });
  });
}

export async function markCompleted(id: string) {
  return prisma.indexQueueItem.update({
    where: { id },
    data: { status: "COMPLETED", completedAt: new Date(), claimedAt: null, lastError: null, dedupeKey: null },
  });
}

export async function markFailed(id: string, error: string, retryAt?: Date) {
  try {
    return await prisma.$transaction(async (tx) => {
      const item = await tx.indexQueueItem.findUniqueOrThrow({ where: { id } });
      const pendingIntentKey = createPendingIntentKey(item);
      const successor = await tx.indexQueueItem.findUnique({ where: { dedupeKey: pendingIntentKey } });
      const retryCount = item.retryCount + 1;
      const transition = processingFailureTransition({
        retryCount: item.retryCount,
        maxRetries: item.maxRetries,
        error,
        retryAt: retryAt ?? new Date(Date.now() + 60_000 * 2 ** Math.min(retryCount, 8)),
        pendingIntentKey,
        hasPendingSuccessor: Boolean(successor && successor.id !== item.id),
        now: new Date(),
      });
      const updated = await tx.indexQueueItem.updateMany({
        where: { id, status: "PROCESSING" },
        data: transition,
      });
      if (updated.count === 0) return tx.indexQueueItem.findUniqueOrThrow({ where: { id } });
      return tx.indexQueueItem.findUniqueOrThrow({ where: { id } });
    });
  } catch (caught) {
    if (!(caught instanceof Prisma.PrismaClientKnownRequestError) || caught.code !== "P2002") throw caught;
    await prisma.indexQueueItem.updateMany({
      where: { id, status: "PROCESSING" },
      data: retryRaceSupersededTransition(error, new Date()),
    });
    return prisma.indexQueueItem.findUniqueOrThrow({ where: { id } });
  }
}

export async function cancelPendingForProduct(shopId: string, shopifyProductGid: string) {
  return prisma.indexQueueItem.updateMany({
    where: { shopId, shopifyProductGid, status: "PENDING" },
    data: { status: "CANCELLED", completedAt: new Date(), claimedAt: null, dedupeKey: null },
  });
}

export async function cancelPendingForProductWithClient(
  tx: Prisma.TransactionClient,
  shopId: string,
  shopifyProductGid: string,
  action?: IndexQueueAction,
) {
  return tx.indexQueueItem.updateMany({
    where: { shopId, shopifyProductGid, status: "PENDING", ...(action ? { action } : {}) },
    data: { status: "CANCELLED", completedAt: new Date(), claimedAt: null, dedupeKey: null },
  });
}
