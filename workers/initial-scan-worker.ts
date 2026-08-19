import prisma from "../app/db.server";
import { resumeInitialScan, runNextBatch } from "../app/services/initial-scan.server";
import {
  decideWorkerAction,
  parseBatchSize,
  parseInterBatchDelay,
  parseMaxBatches,
  reachedWorkerSafetyCeiling,
  resolveUnscopedEligibleRun,
  shouldRetryAuthentication,
} from "../app/services/scan-worker-control";
import { isShopifyUnauthorizedError } from "../app/services/shopify-errors";
import { unauthenticated } from "../app/shopify.server";

let stopRequested = false;
let releaseDelay: (() => void) | undefined;

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...details }));
}

function requestStop(signal: string) {
  stopRequested = true;
  log("scan_worker_shutdown_requested", { signal });
  releaseDelay?.();
}

process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

async function delay(ms: number) {
  if (ms === 0 || stopRequested) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    releaseDelay = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  releaseDelay = undefined;
}

async function resolveScan() {
  const runId = process.env.SCAN_RUN_ID?.trim();
  if (runId) {
    const run = await prisma.scanRun.findUnique({ where: { id: runId }, include: { shop: true } });
    if (!run) throw new Error(`SCAN_RUN_ID did not match a scan run: ${runId}`);
    return run;
  }

  const shopDomain = process.env.SCAN_SHOP_DOMAIN?.trim();
  if (shopDomain) {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) throw new Error(`SCAN_SHOP_DOMAIN did not match a shop: ${shopDomain}`);
    return prisma.scanRun.findFirst({
      where: { shopId: shop.id, activeKey: { not: null } },
      orderBy: { createdAt: "desc" },
      include: { shop: true },
    });
  }

  const eligible = await prisma.scanRun.findMany({
    where: { status: { in: ["PENDING", "RUNNING", "FAILED"] } },
    orderBy: { createdAt: "asc" },
    take: 2,
    include: { shop: true },
  });
  const selection = resolveUnscopedEligibleRun(eligible.map((run) => run.id));
  if (selection.kind === "none") return null;
  if (selection.kind === "ambiguous") {
    throw new Error("Multiple eligible scan runs exist; set SCAN_RUN_ID or SCAN_SHOP_DOMAIN");
  }
  return eligible[0];
}

async function main() {
  const batchSize = parseBatchSize(process.env.SCAN_BATCH_SIZE);
  const maxBatches = parseMaxBatches(process.env.SCAN_MAX_BATCHES);
  const interBatchDelayMs = parseInterBatchDelay(process.env.SCAN_INTER_BATCH_DELAY_MS);
  const selected = await resolveScan();

  if (!selected) {
    log("scan_worker_no_eligible_run");
    return;
  }

  const runId = selected.id;
  const shopDomain = selected.shop.domain;
  let initialFailedResumeUsed = false;
  let batchesExecuted = 0;

  log("scan_worker_started", { runId, shop: shopDomain, batchSize, maxBatches, interBatchDelayMs });

  while (!stopRequested && !reachedWorkerSafetyCeiling(batchesExecuted, maxBatches)) {
    let current = await prisma.scanRun.findUniqueOrThrow({ where: { id: runId } });
    const action = decideWorkerAction(current.status);

    if (action === "stop") {
      log("scan_worker_stopped_for_status", { runId, shop: shopDomain, status: current.status });
      return;
    }

    if (action === "resume") {
      if (initialFailedResumeUsed) {
        throw new Error("Scan returned to FAILED after its controlled worker resume");
      }
      current = await resumeInitialScan(shopDomain, runId);
      initialFailedResumeUsed = true;
      log("scan_worker_resumed_failed_run", { runId, shop: shopDomain, cursor: current.cursor });
    }

    if (stopRequested) break;
    if (!current || !["PENDING", "RUNNING"].includes(current.status)) continue;

    const beforeProcessed = current.productsProcessed;
    const beforeCursor = current.cursor;
    let result: Awaited<ReturnType<typeof runNextBatch>> | undefined;
    let authenticationRetries = 0;
    while (!result) {
      try {
        const { admin, session } = await unauthenticated.admin(shopDomain);
        log("scan_worker_admin_context_acquired", {
          runId,
          shop: shopDomain,
          sessionExpiresAt: session.expires?.toISOString() ?? null,
          authenticationRetries,
        });
        if (stopRequested) break;
        result = await runNextBatch({
          admin,
          shopDomain,
          runId,
          batchSize,
          refreshAdmin: async () => {
            const refreshed = await unauthenticated.admin(shopDomain);
            log("scan_worker_product_admin_context_refreshed", {
              runId,
              shop: shopDomain,
              sessionExpiresAt: refreshed.session.expires?.toISOString() ?? null,
            });
            return refreshed.admin;
          },
        });
      } catch (error) {
        if (isShopifyUnauthorizedError(error) && shouldRetryAuthentication(authenticationRetries)) {
          authenticationRetries += 1;
          const resumed = await resumeInitialScan(shopDomain, runId);
          log("scan_worker_authentication_retry", {
            runId,
            shop: shopDomain,
            cursor: resumed.cursor,
            authenticationRetries,
          });
          continue;
        }
        log("scan_worker_batch_failed", {
          runId,
          shop: shopDomain,
          unauthorized: isShopifyUnauthorizedError(error),
          error: error instanceof Error ? error.message : "Unknown batch failure",
        });
        throw error;
      }
    }
    if (!result) break;
    initialFailedResumeUsed = false;
    batchesExecuted += 1;

    log("scan_worker_progress", {
      runId,
      shop: shopDomain,
      status: result.status,
      productsProcessed: result.productsProcessed,
      productsIndexable: result.productsIndexable,
      productsNonIndexable: result.productsNonIndexable,
      productsChanged: result.productsChanged,
      queueItemsCreated: result.queueItemsCreated,
      errorsCount: result.errorsCount,
      batchesExecuted,
      forwardProgress: result.productsProcessed !== beforeProcessed || result.cursor !== beforeCursor,
    });

    if (result.status === "COMPLETED") {
      log("scan_worker_completed", {
        runId,
        shop: shopDomain,
        productsProcessed: result.productsProcessed,
        productsIndexable: result.productsIndexable,
        productsNonIndexable: result.productsNonIndexable,
        productsChanged: result.productsChanged,
        queueItemsCreated: result.queueItemsCreated,
        errorsCount: result.errorsCount,
        batchesExecuted,
      });
      return;
    }
    if (result.status === "PAUSED" || result.status === "CANCELLED") {
      log("scan_worker_stopped_for_status", { runId, shop: shopDomain, status: result.status });
      return;
    }
    if (stopRequested) break;
    await delay(interBatchDelayMs);
  }

  if (stopRequested) {
    log("scan_worker_stopped_after_checkpoint", { runId, shop: shopDomain, batchesExecuted });
    return;
  }
  log("scan_worker_safety_ceiling_reached", { runId, shop: shopDomain, batchesExecuted, maxBatches });
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "scan_worker_failed",
      error: error instanceof Error ? error.message : "Unknown worker failure",
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
