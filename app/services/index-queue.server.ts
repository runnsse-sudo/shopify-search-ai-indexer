import { Prisma, type IndexProvider, type IndexQueueAction } from "@prisma/client";
import prisma from "../db.server";
import {
  acquirePendingIntentSlot,
  createPendingIntentKey,
  pendingIntentRefresh,
} from "./index-queue-intent";
import {
  claimNextWithClient,
  markCompletedWithClient,
  markFailedWithClient,
  recoverExpiredProcessingWithClient,
} from "./index-queue-orchestration";

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
  return prisma.$transaction((tx) => claimNextWithClient(tx, provider));
}

export async function markCompleted(id: string, expectedClaimedAt: Date) {
  return markCompletedWithClient(prisma, id, expectedClaimedAt);
}

export async function markFailed(id: string, expectedClaimedAt: Date, error: string, retryAt?: Date) {
  return markFailedWithClient({
    client: prisma,
    runTransaction: (operation) => prisma.$transaction(operation),
    isUniqueConstraintError: (caught) =>
      caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002",
    id,
    expectedClaimedAt,
    error,
    retryAt,
  });
}

export async function recoverExpiredProcessing(input: {
  provider: IndexProvider;
  leaseBefore?: Date;
  leaseDurationMs?: number;
  limit?: number;
}) {
  return recoverExpiredProcessingWithClient({
    client: prisma,
    runTransaction: (operation) => prisma.$transaction(operation),
    isUniqueConstraintError: (caught) =>
      caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002",
    ...input,
  });
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
