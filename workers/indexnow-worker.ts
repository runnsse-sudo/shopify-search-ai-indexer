import prisma from "../app/db.server";
import { createIndexAttempt } from "../app/services/index-attempt.server";
import { claimNext, markCompleted, markFailed, recoverExpiredProcessing } from "../app/services/index-queue.server";
import { sendPreparedIndexNowRequest } from "../app/services/indexnow-client";
import { executeOneIndexNowItem } from "../app/services/indexnow-executor.server";
import { parseIndexNowExecutionConfig, sanitizeIndexNowConfig } from "../app/services/indexnow-execution-config";
import {
  parseIndexNowInterItemDelay,
  parseIndexNowMaxItems,
  indexNowWorkerEventForOutcome,
  shouldClaimAnotherIndexNowItem,
} from "../app/services/indexnow-worker-control";

let stopRequested = false;
let releaseDelay: (() => void) | undefined;

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...details }));
}

function requestStop(signal: string) {
  stopRequested = true;
  log("indexnow_worker_shutdown_requested", { signal });
  releaseDelay?.();
}

process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

async function delay(ms: number) {
  if (ms === 0 || stopRequested) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    releaseDelay = () => { clearTimeout(timer); resolve(); };
  });
  releaseDelay = undefined;
}

async function main() {
  const config = parseIndexNowExecutionConfig(process.env);
  if (!config.enabled) {
    log("indexnow_worker_disabled", sanitizeIndexNowConfig(config));
    return;
  }
  const maxItems = parseIndexNowMaxItems(process.env.INDEXNOW_MAX_ITEMS);
  const interItemDelayMs = parseIndexNowInterItemDelay(process.env.INDEXNOW_INTER_ITEM_DELAY_MS);
  log("indexnow_worker_started", { ...sanitizeIndexNowConfig(config), maxItems, interItemDelayMs });

  let processed = 0;
  while (shouldClaimAnotherIndexNowItem(stopRequested, processed, maxItems)) {
    const result = await executeOneIndexNowItem(process.env, {
      resolveShopId: async (domain) => (await prisma.shop.findUnique({ where: { domain }, select: { id: true } }))?.id ?? null,
      recover: recoverExpiredProcessing,
      claim: claimNext,
      invoke: sendPreparedIndexNowRequest,
      createAttempt: createIndexAttempt,
      complete: markCompleted,
      fail: markFailed,
      now: () => new Date(),
      beforeInvoke: (details) => log("indexnow_item_claimed", details),
    });
    if (result.outcome === "no_work") {
      log("indexnow_worker_no_work", { processed });
      break;
    }
    if (result.outcome === "disabled") break;
    processed += 1;
    const event = indexNowWorkerEventForOutcome(result.outcome);
    log(event, { queueItemId: result.queueItemId, processed, outcome: result.outcome });
    if (shouldClaimAnotherIndexNowItem(stopRequested, processed, maxItems)) await delay(interItemDelayMs);
  }
  log("indexnow_worker_stopped", { processed, stopRequested });
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "indexnow_worker_failed",
      error: error instanceof Error ? error.message : "Unknown IndexNow worker failure",
    }));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
