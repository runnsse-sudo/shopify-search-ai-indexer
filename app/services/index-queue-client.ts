import type { IndexProvider, IndexQueueAction, Prisma } from "@prisma/client";

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
