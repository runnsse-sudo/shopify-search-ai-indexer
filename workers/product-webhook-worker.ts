import prisma from "../app/db.server";
import { unauthenticated, sessionStorage } from "../app/shopify.server";
import { processProductDetection } from "../app/services/product-indexing.server";
import { productWebhookConfig, startProductWebhookWatchdog } from "../app/services/product-webhook-control";
import { productWebhookAdminClient } from "../app/services/product-webhook-admin";
import { runProductWebhookWorker, runManifestBoundProductWebhookDrain, type ProductWebhookRunnerDependencies } from "../app/services/product-webhook-runner";
import { prepareProductWebhookDrainAuth } from "../app/services/product-webhook-drain-auth.server";
import { drainNeed } from "../app/services/product-webhook-drain-contract";
import {
  acquireProductWebhookLeaseWithClient,
  releaseProductWebhookLeaseWithClient,
  claimProductWebhookWithClient,
  failProductWebhookWithClient,
  guardProductWebhookClaimWithClient,
  preflightProductWebhookDrainWithClient,
  claimManifestProductWebhookWithClient,
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
  if (process.env.PRODUCT_WEBHOOK_WORKER_ENABLED === "true") clearWatchdog = startProductWebhookWatchdog();
  const config = productWebhookConfig(process.env);
  const deps: ProductWebhookRunnerDependencies = {
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
  };
  if (!config.drain) return runProductWebhookWorker(config, deps);
  const spec = config.drain;
  return runManifestBoundProductWebhookDrain(config, {
    ...deps,
    preflight: () => prisma.$transaction(tx => preflightProductWebhookDrainWithClient(tx, spec, new Date()), { isolationLevel: "Serializable" }),
    auth: (shop) => prepareProductWebhookDrainAuth({
      spec, requiredScopes: process.env.SCOPES ?? "", now: () => new Date(), fetch,
      readMetadata: async () => {
        const current = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id }, select: { domain: true, primaryDomain: true } });
        drainNeed(current.domain === shop.domain && current.primaryDomain === shop.primaryDomain, "AUTH_SESSION_DRIFT");
        const sessions = await prisma.session.findMany({ where: { shop: current.domain, isOnline: false }, select: { id: true, shop: true, isOnline: true, scope: true, expires: true } });
        return { ...current, sessions };
      },
      loadSession: id => sessionStorage.loadSession(id),
    }),
    claim: (member, lease, now, expectedDomain) => runSerializableTransactionWithRetry(() => prisma.$transaction(tx => claimManifestProductWebhookWithClient(tx, spec, member, lease, now, expectedDomain), { isolationLevel: "Serializable" })),
    process: async (work, admin, effects) => {
      const result = await processProductDetection({ admin, shopDomain: work.shop.domain, productGid: work.shopifyProductGid!, eventType: work.topic === "products/create" ? "CREATED" : "UPDATED", metadata: { webhookId: work.webhookId, eventId: work.eventId, triggeredAt: work.triggeredAt }, durableClaim: work, drainEffects: effects });
      return { drainEffects: "drainEffects" in result ? result.drainEffects : undefined };
    },
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
