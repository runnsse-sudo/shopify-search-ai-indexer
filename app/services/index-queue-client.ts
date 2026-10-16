import type { IndexProvider, IndexQueueAction, Prisma } from "@prisma/client";
import { assertDrainQueue, drainNeed, type DrainTransactionFence } from "./product-webhook-drain-contract.ts";

import {
  acquirePendingIntentSlot,
  createPendingIntentKey,
  pendingIntentRefresh,
} from "./index-queue-intent.ts";

export type EnqueueProductInput = {
  shopId: string;
  productIndexStateId?: string | null;
  shopifyProductGid: string;
  url: string | null;
  reason: string;
  provider?: IndexProvider;
  action?: IndexQueueAction;
};

export async function enqueueProductWithClient(
  tx: Prisma.TransactionClient,
  input: EnqueueProductInput,
  drainFence?: DrainTransactionFence,
) {
  const provider = input.provider ?? "INTERNAL";
  const action = input.action ?? "INDEX";
  const dedupeKey = createPendingIntentKey({ ...input, provider, action });
  const now = new Date();
  let insertedHere = false;
  if (drainFence) drainNeed(provider === "INTERNAL" && input.shopId === drainFence.shopId && input.shopifyProductGid === drainFence.shopifyProductGid);
  const result = await acquirePendingIntentSlot({
    maxAttempts: 3,
    createSlot: async () => {
      const inserted = await tx.indexQueueItem.createMany({
        data: [{ ...input, provider, action, dedupeKey, nextAttemptAt: now }],
        skipDuplicates: true,
      });
      insertedHere ||= inserted.count === 1;
      return inserted.count === 1;
    },
    refreshSlot: async () => {
      if (drainFence) {
        const row = await tx.indexQueueItem.findFirst({ where: { dedupeKey, status: "PENDING" } });
        drainNeed(row && row.shopId === drainFence.shopId && row.shopifyProductGid === drainFence.shopifyProductGid && row.provider === "INTERNAL" && row.action === action);
        if (insertedHere) drainNeed(drainFence.state.created.size + drainFence.created.size < 20);
        else assertDrainQueue(drainFence, row);
      }
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
  if (drainFence) {
    drainNeed(result.item && result.item.provider === "INTERNAL" && result.item.action === action && result.item.status === "PENDING" && result.item.dedupeKey === dedupeKey);
    if (insertedHere) drainFence.created.add(result.item.id);
  }
  return { item: result.item, created: result.created };
}

export async function cancelPendingForProviderActionWithClient(
  tx: Prisma.TransactionClient,
  input: {
    shopId: string;
    shopifyProductGid: string;
    provider: IndexProvider;
    action: IndexQueueAction;
  },
) {
  return tx.indexQueueItem.updateMany({
    where: {
      shopId: input.shopId,
      shopifyProductGid: input.shopifyProductGid,
      provider: input.provider,
      action: input.action,
      status: "PENDING",
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      claimedAt: null,
      dedupeKey: null,
    },
  });
}
