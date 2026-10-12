import {
  WebhookOwnershipLostError,
  classifyProductWebhookError,
  type ProductWebhookConfig,
} from "./product-webhook-control.ts";
import type {
  ProductWebhookLease,
  claimProductWebhookWithClient,
  failProductWebhookWithClient,
} from "./product-webhook-store.ts";
import type { AdminGraphqlClient } from "./shopify-product.server.ts";

type Claimed = NonNullable<
  Awaited<ReturnType<typeof claimProductWebhookWithClient>>
>;
type Work = Extract<Claimed, { exhausted: false }>;
export type ProductWebhookRunnerDependencies = {
  acquireLease: () => Promise<ProductWebhookLease | null>;
  releaseLease: (lease: ProductWebhookLease) => Promise<void>;
  claim: (
    lease: ProductWebhookLease,
    excludedShopIds: string[],
    now: Date,
  ) => Promise<Claimed | null>;
  admin: (domain: string) => Promise<AdminGraphqlClient>;
  guard: (work: Work, now: Date) => Promise<void>;
  process: (work: Work, admin: AdminGraphqlClient) => Promise<unknown>;
  fail: (
    work: Work,
    error: ReturnType<typeof classifyProductWebhookError>,
    now: Date,
  ) => ReturnType<typeof failProductWebhookWithClient>;
  log: (
    event: string,
    details?: Record<string, string | number | boolean>,
  ) => void;
  now: () => Date;
  delay: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
};

export async function runProductWebhookWorker(
  config: ProductWebhookConfig,
  deps: ProductWebhookRunnerDependencies,
) {
  if (!config.enabled) {
    deps.log("product_webhook_worker_disabled");
    return;
  }
  const lease = await deps.acquireLease();
  if (!lease) {
    deps.log("product_webhook_worker_stopped", { reason: "LEASE_BUSY" });
    return;
  }
  let claimed = 0,
    completed = 0,
    retries = 0,
    failed = 0;
  const perShop = new Map<string, number>(),
    blocked = new Set<string>();
  deps.log("product_webhook_worker_started", {
    maxItems: config.maxItems,
    maxItemsPerShop: config.maxItemsPerShop,
  });
  try {
    while (claimed < config.maxItems && !deps.shouldStop()) {
      const excluded = [
        ...new Set([
          ...blocked,
          ...[...perShop]
            .filter(([, count]) => count >= config.maxItemsPerShop)
            .map(([id]) => id),
        ]),
      ];
      const work = await deps.claim(lease, excluded, deps.now());
      if (!work) break;
      claimed++;
      perShop.set(work.shopId, (perShop.get(work.shopId) ?? 0) + 1);
      if (work.exhausted) {
        failed++;
        deps.log("product_webhook_item_failed", { code: "ATTEMPTS_EXHAUSTED" });
        continue;
      }
      deps.log("product_webhook_item_claimed", { attempt: work.attemptCount });
      if (work.staleRecovered) deps.log("product_webhook_item_stale_recovered");
      let acquisition = true;
      try {
        const admin = await deps.admin(work.shop.domain);
        if (deps.shouldStop()) break;
        await deps.guard(work, deps.now());
        if (deps.shouldStop()) break;
        acquisition = false;
        if (!work.shopifyProductGid) {
          await deps.fail(
            work,
            { code: "INVALID_WORK", retryable: false },
            deps.now(),
          );
          failed++;
          deps.log("product_webhook_item_failed", { code: "INVALID_WORK" });
          continue;
        }
        await deps.process(work, admin);
        completed++;
        deps.log("product_webhook_item_completed");
      } catch (error) {
        if (error instanceof WebhookOwnershipLostError) throw error;
        const classified = acquisition
          ? { code: "ADMIN_UNAVAILABLE" as const, retryable: true }
          : classifyProductWebhookError(error);
        const result = await deps.fail(work, classified, deps.now());
        if (classified.retryable) blocked.add(work.shopId);
        if (result.status === "RETRY") {
          retries++;
          deps.log("product_webhook_item_retry_scheduled", {
            code: result.lastErrorClass,
            attempt: work.attemptCount,
          });
        } else {
          failed++;
          deps.log("product_webhook_item_failed", {
            code: result.lastErrorClass,
            attempt: work.attemptCount,
          });
        }
      }
      if (claimed < config.maxItems && !deps.shouldStop())
        await deps.delay(config.interItemDelayMs);
    }
  } catch (error) {
    if (!(error instanceof WebhookOwnershipLostError)) throw error;
    deps.log("product_webhook_worker_stopped", { reason: "OWNERSHIP_LOST" });
  } finally {
    await deps.releaseLease(lease);
  }
  deps.log("product_webhook_worker_stopped", {
    claimed,
    completed,
    retries,
    failed,
  });
}
