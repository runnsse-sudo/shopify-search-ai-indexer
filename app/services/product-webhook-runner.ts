import {
  WebhookOwnershipLostError,
  classifyProductWebhookError,
  type ProductWebhookConfig,
  PRODUCT_WEBHOOK_HARD_LIMIT_MS,
} from "./product-webhook-control.ts";
import type {
  ProductWebhookLease,
  claimProductWebhookWithClient,
  failProductWebhookWithClient,
  claimManifestProductWebhookWithClient,
  preflightProductWebhookDrainWithClient,
} from "./product-webhook-store.ts";
import type { AdminGraphqlClient } from "./shopify-product.server.ts";
import { ProductWebhookDrainBlocked, drainNeed, createDrainEffectState, commitDrainEffect, type DrainMember, type DrainEffectState, type DrainCommittedEffect } from "./product-webhook-drain-contract.ts";

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
  drainNeed(!config.drain, "DRAIN_MODE_DISPATCH_REQUIRED");
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

export type ProductWebhookDrainDependencies = Omit<ProductWebhookRunnerDependencies, "claim" | "admin" | "process"> & {
  preflight: () => ReturnType<typeof preflightProductWebhookDrainWithClient>;
  auth: (shop: Awaited<ReturnType<typeof preflightProductWebhookDrainWithClient>>["shop"]) => Promise<{ admin: AdminGraphqlClient; check: () => Promise<void> }>;
  claim: (member: DrainMember, lease: ProductWebhookLease, now: Date, expectedDomain: string) => ReturnType<typeof claimManifestProductWebhookWithClient>;
  process: (work: Work, admin: AdminGraphqlClient, effects: DrainEffectState) => Promise<{ drainEffects?: DrainCommittedEffect }>;
};
const drainStopCodes = new Set(["DRAIN_SCOPE_DRIFT", "DRAIN_CONFIG_INVALID", "DRAIN_MANIFEST_DRIFT", "DRAIN_STOPPED", "DRAIN_INCOMPLETE", "AUTH_BLOCKED", "AUTH_REFRESH_REQUIRED", "AUTH_SCOPE_MISMATCH", "AUTH_SESSION_DRIFT", "AUTH_QUERY_BLOCKED", "AUTH_DOMAIN_DRIFT"]);
export async function runManifestBoundProductWebhookDrain(config: ProductWebhookConfig, deps: ProductWebhookDrainDependencies) {
  drainNeed(config.drain, "DRAIN_CONFIG_INVALID");
  if (!config.enabled) { deps.log("product_webhook_worker_disabled"); return; }
  const spec = config.drain, effects = createDrainEffectState(spec);
  const started = +deps.now();
  let lease: ProductWebhookLease | null = null, claimed = 0, completed = 0, retries = 0, failed = 0;
  let reason = "DRAIN_INCOMPLETE";
  const stop = () => { const elapsed = +deps.now() - started; drainNeed(!deps.shouldStop() && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < PRODUCT_WEBHOOK_HARD_LIMIT_MS, "DRAIN_STOPPED"); };
  try {
    stop(); const initial = await deps.preflight();
    const auth = await deps.auth(initial.shop); stop();
    lease = await deps.acquireLease();
    if (!lease) throw new ProductWebhookDrainBlocked("LEASE_BUSY");
    const fresh = await deps.preflight();
    drainNeed(fresh.order.length === 20 && fresh.order.every((m, i) => m.id === initial.order[i].id), "DRAIN_MANIFEST_DRIFT");
    for (const member of fresh.order) {
      stop(); await auth.check(); stop();
      const work = await deps.claim(member, lease, deps.now(), initial.shop.domain); claimed++;
      deps.log("product_webhook_drain_claimed", { ordinal: spec.manifest.findIndex(r => r.id === member.id) + 1, manifestSha256: spec.sha256 });
      try {
        await deps.guard(work, deps.now()); stop();
        const result = await deps.process(work, auth.admin, effects);
        drainNeed(result.drainEffects, "DRAIN_SCOPE_DRIFT");
        commitDrainEffect(effects, result.drainEffects); completed++;
        deps.log("product_webhook_drain_completed", { ordinal: spec.manifest.findIndex(r => r.id === member.id) + 1, manifestSha256: spec.sha256 });
      } catch (error) {
        if (error instanceof WebhookOwnershipLostError) throw error;
        const classified = classifyProductWebhookError(error);
        const result = await deps.fail(work, classified, deps.now());
        if (result.status === "RETRY") retries++; else failed++;
        throw error;
      }
      if (completed < 20) { stop(); await deps.delay(1000); }
    }
    drainNeed(claimed === 20 && completed === 20 && retries === 0 && failed === 0, "DRAIN_INCOMPLETE");
    reason = "COMPLETED";
  } catch (error) {
    reason = error instanceof WebhookOwnershipLostError ? "OWNERSHIP_LOST" : error instanceof ProductWebhookDrainBlocked && (drainStopCodes.has(error.code) || error.code === "LEASE_BUSY") ? error.code : "WORKER_FAILURE";
    throw new ProductWebhookDrainBlocked(reason);
  } finally {
    try { if (lease) await deps.releaseLease(lease); }
    finally { deps.log("product_webhook_drain_stopped", { manifestSha256: spec.sha256, claimed, completed, retries, failed, reason }); }
  }
}
