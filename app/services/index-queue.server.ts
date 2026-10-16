import { Prisma, type IndexProvider, type IndexQueueAction } from "@prisma/client";
import prisma from "../db.server";
import { assertDrainQueue, drainNeed, type DrainTransactionFence } from "./product-webhook-drain-contract";
import {
  cancelPendingForProviderActionWithClient,
  enqueueProductWithClient,
  type EnqueueProductInput,
} from "./index-queue-client";
import {
  claimNextWithClient,
  markCompletedWithClient,
  markFailedWithClient,
  recoverExpiredProcessingWithClient,
} from "./index-queue-orchestration";

export {
  cancelPendingForProviderActionWithClient,
  enqueueProductWithClient,
  type EnqueueProductInput,
};

export async function enqueueProduct(input: EnqueueProductInput) {
  return prisma.$transaction((tx) => enqueueProductWithClient(tx, input));
}

export async function claimNext(provider: IndexProvider = "INTERNAL", shopId?: string) {
  return prisma.$transaction((tx) => claimNextWithClient(tx, provider, undefined, shopId));
}

export async function markCompleted(id: string, expectedClaimedAt: Date) {
  return markCompletedWithClient(prisma, id, expectedClaimedAt);
}

export async function markFailed(id: string, expectedClaimedAt: Date, error: string, retryAt?: Date, terminal = false) {
  return markFailedWithClient({
    client: prisma,
    runTransaction: (operation) => prisma.$transaction(operation),
    isUniqueConstraintError: (caught) =>
      caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002",
    id,
    expectedClaimedAt,
    error,
    retryAt,
    terminal,
  });
}

export async function recoverExpiredProcessing(input: {
  provider: IndexProvider;
  leaseBefore?: Date;
  leaseDurationMs?: number;
  limit?: number;
  shopId?: string;
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
  drainFence?: DrainTransactionFence,
) {
  if (drainFence) {
    drainNeed(shopId === drainFence.shopId && shopifyProductGid === drainFence.shopifyProductGid && action);
    const rows = await tx.indexQueueItem.findMany({ where: { shopId, shopifyProductGid, status: "PENDING", action }, take: 501 });
    drainNeed(rows.length <= 500); rows.forEach(row => assertDrainQueue(drainFence, row));
    drainNeed(new Set([...drainFence.state.cancelled, ...rows.map(r => r.id)]).size <= 37);
    const result = await tx.indexQueueItem.updateMany({ where: { shopId, shopifyProductGid, status: "PENDING", action, id: { in: rows.map(r => r.id) }, OR: rows.map(r => ({ id: r.id, updatedAt: r.updatedAt, provider: r.provider })) }, data: { status: "CANCELLED", completedAt: new Date(), claimedAt: null, dedupeKey: null } });
    drainNeed(result.count === rows.length); rows.forEach(r => drainFence.cancelled.add(r.id)); return result;
  }
  return tx.indexQueueItem.updateMany({
    where: { shopId, shopifyProductGid, status: "PENDING", ...(action ? { action } : {}) },
    data: { status: "CANCELLED", completedAt: new Date(), claimedAt: null, dedupeKey: null },
  });
}
