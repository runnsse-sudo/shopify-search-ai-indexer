import prisma from "../app/db.server";
import { processProductDetection } from "../app/services/product-indexing.server";
import { selectRepairProductGids } from "../app/services/scan-repair";
import { shouldRetryAuthentication } from "../app/services/scan-worker-control";
import { isShopifyUnauthorizedError } from "../app/services/shopify-errors";
import { unauthenticated } from "../app/shopify.server";

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...details }));
}

async function main() {
  const runId = process.env.REPAIR_SCAN_RUN_ID?.trim();
  if (!runId) throw new Error("REPAIR_SCAN_RUN_ID is required");

  const run = await prisma.scanRun.findUnique({ where: { id: runId }, include: { shop: true } });
  if (!run) throw new Error(`REPAIR_SCAN_RUN_ID did not match a scan run: ${runId}`);
  if (!run.startedAt) throw new Error("Repair requires a scan run with startedAt");
  if (!run.completedAt) throw new Error("Repair requires a completed scan run with completedAt");

  const sourceEvents = await prisma.indexEvent.findMany({
    where: {
      shopId: run.shopId,
      eventType: "INITIAL_SCAN",
      error: { not: null },
      receivedAt: { gte: run.startedAt, lte: run.completedAt },
    },
    select: { shopId: true, shopifyProductGid: true, eventType: true, error: true, receivedAt: true },
    orderBy: { receivedAt: "asc" },
  });
  const productGids = selectRepairProductGids(
    sourceEvents,
    run.shopId,
    run.startedAt,
    run.completedAt,
  );
  let succeeded = 0;
  let failed = 0;
  let changed = 0;
  let queued = 0;
  let indexable = 0;
  let nonIndexable = 0;

  log("scan_repair_started", {
    repairOfScanRunId: run.id,
    shop: run.shop.domain,
    sourceFailuresFound: sourceEvents.length,
    uniqueProductsToRepair: productGids.length,
  });

  for (const productGid of productGids) {
    let authenticationRetries = 0;
    let repaired = false;
    while (!repaired) {
      try {
        const { admin, session } = await unauthenticated.admin(run.shop.domain);
        log("scan_repair_admin_context_acquired", {
          repairOfScanRunId: run.id,
          shop: run.shop.domain,
          productGid,
          sessionExpiresAt: session.expires?.toISOString() ?? null,
          authenticationRetries,
        });
        const result = await processProductDetection({
          admin,
          shopDomain: run.shop.domain,
          productGid,
          eventType: "MANUAL_SCAN",
          metadata: {
            repairOfScanRunId: run.id,
            repairReason: "SCAN_PRODUCT_ERROR",
          },
        });
        succeeded += 1;
        if (result.changed) changed += 1;
        if (result.queued) queued += 1;
        if (result.indexabilityState === "INDEXABLE") indexable += 1;
        else nonIndexable += 1;
        repaired = true;
        log("scan_repair_product_repaired", {
          repairOfScanRunId: run.id,
          productGid,
          ...result,
        });
      } catch (error) {
        if (isShopifyUnauthorizedError(error) && shouldRetryAuthentication(authenticationRetries)) {
          authenticationRetries += 1;
          log("scan_repair_authentication_retry", {
            repairOfScanRunId: run.id,
            productGid,
            authenticationRetries,
          });
          continue;
        }
        failed += 1;
        repaired = true;
        log("scan_repair_product_failed", {
          repairOfScanRunId: run.id,
          productGid,
          unauthorized: isShopifyUnauthorizedError(error),
          error: error instanceof Error ? error.message : "Unknown repair failure",
        });
      }
    }
  }

  log("scan_repair_completed", {
    repairOfScanRunId: run.id,
    shop: run.shop.domain,
    sourceFailuresFound: sourceEvents.length,
    uniqueProductsToRepair: productGids.length,
    repaired: succeeded,
    changed,
    queued,
    indexable,
    nonIndexable,
    failed,
  });
  if (failed > 0) throw new Error(`Scan error repair finished with ${failed} failed product(s)`);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "scan_repair_worker_failed",
      error: error instanceof Error ? error.message : "Unknown repair worker failure",
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
