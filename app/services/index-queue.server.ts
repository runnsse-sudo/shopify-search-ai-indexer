import type { IndexProvider, IndexQueueAction, Prisma } from "@prisma/client";
import prisma from "../db.server";

export type EnqueueProductInput = {
  shopId: string;
  productIndexStateId?: string;
  shopifyProductGid: string;
  url: string | null;
  reason: string;
  provider?: IndexProvider;
  action?: IndexQueueAction;
};

function createDedupeKey(input: EnqueueProductInput, provider: IndexProvider, action: IndexQueueAction) {
  return [input.shopId, input.shopifyProductGid, provider, action, input.reason].join("|");
}

export async function enqueueProductWithClient(
  tx: Prisma.TransactionClient,
  input: EnqueueProductInput,
) {
  const provider = input.provider ?? "INTERNAL";
  const action = input.action ?? "INDEX";
  const dedupeKey = createDedupeKey(input, provider, action);
  const existing = await tx.indexQueueItem.findUnique({ where: { dedupeKey } });
  if (existing) return { item: existing, created: false };
  const item = await tx.indexQueueItem.upsert({
    where: { dedupeKey },
    create: { ...input, provider, action, dedupeKey },
    update: {},
  });
  return { item, created: true };
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
    return tx.indexQueueItem.update({
      where: { id: item.id },
      data: { status: "PROCESSING", claimedAt: new Date() },
    });
  });
}

export async function markCompleted(id: string) {
  return prisma.indexQueueItem.update({
    where: { id },
    data: { status: "COMPLETED", completedAt: new Date(), lastError: null, dedupeKey: null },
  });
}

export async function markFailed(id: string, error: string, retryAt?: Date) {
  const item = await prisma.indexQueueItem.findUniqueOrThrow({ where: { id } });
  const retryCount = item.retryCount + 1;
  return prisma.indexQueueItem.update({
    where: { id },
    data: {
      retryCount,
      lastError: error.slice(0, 4000),
      status: retryCount >= item.maxRetries ? "FAILED" : "PENDING",
      dedupeKey: retryCount >= item.maxRetries ? null : item.dedupeKey,
      nextAttemptAt: retryAt ?? new Date(Date.now() + 60_000 * 2 ** Math.min(retryCount, 8)),
      claimedAt: null,
    },
  });
}

export async function cancelPendingForProduct(shopId: string, shopifyProductGid: string) {
  return prisma.indexQueueItem.updateMany({
    where: { shopId, shopifyProductGid, status: "PENDING" },
    data: { status: "CANCELLED", completedAt: new Date(), dedupeKey: null },
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
    data: { status: "CANCELLED", completedAt: new Date(), dedupeKey: null },
  });
}
