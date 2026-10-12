import prisma from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import { processProductDetection } from "../app/services/product-indexing.server";
import { productWebhookConfig, startProductWebhookWatchdog } from "../app/services/product-webhook-control";
import { productWebhookAdminClient } from "../app/services/product-webhook-admin";
import { runProductWebhookWorker } from "../app/services/product-webhook-runner";
import {
  acquireProductWebhookLeaseWithClient,
  releaseProductWebhookLeaseWithClient,
  claimProductWebhookWithClient,
  failProductWebhookWithClient,
  guardProductWebhookClaimWithClient,
} from "../app/services/product-webhook-store";
import { runSerializableTransactionWithRetry } from "../app/services/serializable-transaction-retry.server";

let stopRequested = false;
let clearWatchdog: (() => void) | undefined;
process.on("SIGTERM", () => {
  stopRequested = true;
});
process.on("SIGINT", () => {
  stopRequested = true;
});

async function main() {
  const config = productWebhookConfig(process.env);
  if (config.enabled) clearWatchdog = startProductWebhookWatchdog();
  await runProductWebhookWorker(config, {
    acquireLease: () =>
      acquireProductWebhookLeaseWithClient(
        prisma,
        config.claimStaleMs,
        new Date(),
      ),
    releaseLease: (lease) =>
      releaseProductWebhookLeaseWithClient(prisma, lease),
    claim: (lease, excluded, now) =>
      runSerializableTransactionWithRetry(() =>
        prisma.$transaction(
          (tx) =>
            claimProductWebhookWithClient(tx, config, lease, excluded, now),
          { isolationLevel: "Serializable" },
        ),
      ),
    admin: async (domain) => {
      const { admin, session } = await unauthenticated.admin(domain);
      if (!admin || !session || session.isOnline)
        throw new Error("OFFLINE_ADMIN_UNAVAILABLE");
      return productWebhookAdminClient((query, options) =>
        admin.graphql(query, options),
      );
    },
    guard: (work, now) =>
      runSerializableTransactionWithRetry(() =>
        prisma.$transaction(
          (tx) => guardProductWebhookClaimWithClient(tx, work, now),
          { isolationLevel: "Serializable" },
        ),
      ),
    process: (work, admin) =>
      processProductDetection({
        admin,
        shopDomain: work.shop.domain,
        productGid: work.shopifyProductGid!,
        eventType: work.topic === "products/create" ? "CREATED" : "UPDATED",
        metadata: {
          webhookId: work.webhookId,
          eventId: work.eventId,
          triggeredAt: work.triggeredAt,
        },
        durableClaim: work,
      }),
    fail: (work, error, now) =>
      runSerializableTransactionWithRetry(() =>
        prisma.$transaction(
          (tx) => failProductWebhookWithClient(tx, work, config, error, now),
          { isolationLevel: "Serializable" },
        ),
      ),
    log: (event, details = {}) =>
      console.log(JSON.stringify({ event, ...details })),
    now: () => new Date(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    shouldStop: () => stopRequested,
  });
}

main()
  .catch(() => {
    console.error(
      JSON.stringify({
        event: "product_webhook_worker_failed",
        code: "WORKER_FAILURE",
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      console.error(
        JSON.stringify({
          event: "product_webhook_worker_failed",
          code: "DISCONNECT_FAILURE",
        }),
      );
      process.exitCode = 1;
    } finally {
      clearWatchdog?.();
    }
  });
