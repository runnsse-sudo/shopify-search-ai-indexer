import { Prisma } from "@prisma/client";
import prisma from "../app/db.server";
import {
  assertQueueReconciliationCanApply,
  buildQueueReconciliationPlan,
} from "../app/services/index-queue-intent";

function log(event: string, details: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...details }));
}

async function main() {
  const shopDomain = process.env.QUEUE_RECONCILE_SHOP_DOMAIN?.trim();
  if (!shopDomain) throw new Error("QUEUE_RECONCILE_SHOP_DOMAIN is required");
  const apply = process.env.QUEUE_RECONCILE_APPLY === "true";
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) throw new Error(`Shop was not found: ${shopDomain}`);

  const processingRowsFound = await prisma.indexQueueItem.count({
    where: { shopId: shop.id, provider: "INTERNAL", status: "PROCESSING" },
  });
  const pending = await prisma.indexQueueItem.findMany({
    where: { shopId: shop.id, provider: "INTERNAL", status: "PENDING" },
    select: {
      id: true,
      shopId: true,
      shopifyProductGid: true,
      provider: true,
      action: true,
      status: true,
      dedupeKey: true,
      url: true,
      createdAt: true,
    },
  });
  const plan = buildQueueReconciliationPlan(pending);
  const baseSummary = {
    shop: shop.domain,
    provider: "INTERNAL",
    apply,
    ...plan,
    cancellations: undefined,
    normalizations: undefined,
    processingRowsFound,
  };

  log("queue_reconcile_plan", { ...baseSummary, mutated: 0, failed: 0 });
  if (!apply) {
    log("queue_reconcile_completed", { ...baseSummary, mutated: 0, failed: 0 });
    return;
  }
  if (processingRowsFound > 0) {
    log("queue_reconcile_aborted", { ...baseSummary, mutated: 0, failed: 1 });
    assertQueueReconciliationCanApply(processingRowsFound);
  }

  const appliedResult = await prisma.$transaction(async (tx) => {
    const processingNow = await tx.indexQueueItem.count({
      where: { shopId: shop.id, provider: "INTERNAL", status: "PROCESSING" },
    });
    if (processingNow > 0) throw new Error("PROCESSING row appeared before reconciliation mutation");

    const currentPending = await tx.indexQueueItem.findMany({
      where: { shopId: shop.id, provider: "INTERNAL", status: "PENDING" },
      select: {
        id: true,
        shopId: true,
        shopifyProductGid: true,
        provider: true,
        action: true,
        status: true,
        dedupeKey: true,
        url: true,
        createdAt: true,
      },
    });
    const currentPlan = buildQueueReconciliationPlan(currentPending);

    let count = 0;
    for (const cancellation of currentPlan.cancellations) {
      const result = await tx.indexQueueItem.updateMany({
        where: { id: cancellation.id, shopId: shop.id, provider: "INTERNAL", status: "PENDING" },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          claimedAt: null,
          dedupeKey: null,
          lastError: `Superseded during pending-intent reconciliation by ${cancellation.keeperId}`.slice(0, 4000),
        },
      });
      count += result.count;
    }
    for (const normalization of currentPlan.normalizations) {
      const result = await tx.indexQueueItem.updateMany({
        where: { id: normalization.id, shopId: shop.id, provider: "INTERNAL", status: "PENDING" },
        data: { dedupeKey: normalization.dedupeKey },
      });
      if (result.count !== 1) throw new Error(`Pending keeper changed during reconciliation: ${normalization.id}`);
      count += result.count;
    }
    return { mutated: count, plan: currentPlan };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  log("queue_reconcile_completed", {
    shop: shop.domain,
    provider: "INTERNAL",
    apply,
    ...appliedResult.plan,
    cancellations: undefined,
    normalizations: undefined,
    processingRowsFound,
    mutated: appliedResult.mutated,
    failed: 0,
  });
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "queue_reconcile_failed",
      error: error instanceof Error ? error.message : "Unknown queue reconciliation failure",
    }));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
