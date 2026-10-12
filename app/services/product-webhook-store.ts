import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  WebhookOwnershipLostError,
  productWebhookFailure,
  type ProductWebhookConfig,
  type ProductWebhookErrorClass,
} from "./product-webhook-control.ts";

type Client = Prisma.TransactionClient;
export const PRODUCT_WEBHOOK_LEASE_KEY = "product-webhook-worker-v1";
export type ProductWebhookLease = { ownerToken: string; ttlMs: number };
export type ProductWebhookClaim = {
  id: string;
  shopId: string;
  claimToken: string;
  claimedAt: Date;
  attemptCount: number;
  lease: ProductWebhookLease;
};

export async function acceptProductWebhookWithClient(
  client: Client,
  input: {
    shopDomain: string;
    webhookId: string;
    productGid: string;
    topic: "products/create" | "products/update";
    eventId?: string | null;
    triggeredAt?: string | null;
  },
  now = new Date(),
) {
  if (
    !input.webhookId.trim() ||
    input.webhookId.length > 255 ||
    !/^gid:\/\/shopify\/Product\/\d+$/.test(input.productGid) ||
    !["products/create", "products/update"].includes(input.topic) ||
    (input.eventId?.length ?? 0) > 255 ||
    (input.triggeredAt?.length ?? 0) > 128
  )
    throw new Error("INVALID_PRODUCT_WEBHOOK_INPUT");
  const shop = await client.shop.upsert({
    where: { domain: input.shopDomain },
    create: { domain: input.shopDomain },
    update: {},
  });
  const result = await client.webhookReceipt.createMany({
    data: {
      shopId: shop.id,
      webhookId: input.webhookId,
      topic: input.topic,
      shopifyProductGid: input.productGid,
      eventId: input.eventId ?? null,
      triggeredAt: input.triggeredAt ?? null,
      status: "PENDING",
      processedAt: null,
      receivedAt: now,
      nextAttemptAt: now,
    },
    skipDuplicates: true,
  });
  return result.count === 1
    ? ("ACCEPTED" as const)
    : ("DUPLICATE_DURABLE" as const);
}

export async function acquireProductWebhookLeaseWithClient(
  client: Client,
  ttlMs: number,
  now: Date,
) {
  await client.providerAutomationLease.upsert({
    where: { key: PRODUCT_WEBHOOK_LEASE_KEY },
    create: { key: PRODUCT_WEBHOOK_LEASE_KEY },
    update: {},
  });
  const lease = { ownerToken: randomUUID(), ttlMs };
  const result = await client.providerAutomationLease.updateMany({
    where: {
      key: PRODUCT_WEBHOOK_LEASE_KEY,
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    data: {
      ownerToken: lease.ownerToken,
      leaseUntil: new Date(now.getTime() + ttlMs),
    },
  });
  return result.count === 1 ? lease : null;
}

export async function guardProductWebhookLeaseWithClient(
  client: Client,
  lease: ProductWebhookLease,
  now: Date,
) {
  const result = await client.providerAutomationLease.updateMany({
    where: {
      key: PRODUCT_WEBHOOK_LEASE_KEY,
      ownerToken: lease.ownerToken,
      leaseUntil: { gt: now },
    },
    data: { leaseUntil: new Date(now.getTime() + lease.ttlMs) },
  });
  if (result.count !== 1) throw new WebhookOwnershipLostError();
}

export async function releaseProductWebhookLeaseWithClient(
  client: Client,
  lease: ProductWebhookLease,
) {
  await client.providerAutomationLease.updateMany({
    where: { key: PRODUCT_WEBHOOK_LEASE_KEY, ownerToken: lease.ownerToken },
    data: { ownerToken: null, leaseUntil: null },
  });
}

export function productWebhookClaimWhere(claim: ProductWebhookClaim) {
  return {
    id: claim.id,
    shopId: claim.shopId,
    status: "PROCESSING" as const,
    claimToken: claim.claimToken,
    claimedAt: claim.claimedAt,
  };
}

// Serializable caller; no receipt liveness extension. The hard process bound owns liveness.
export async function guardProductWebhookClaimWithClient(
  client: Client,
  claim: ProductWebhookClaim,
  now: Date,
) {
  if (now.getTime() - claim.claimedAt.getTime() >= claim.lease.ttlMs)
    throw new WebhookOwnershipLostError();
  await guardProductWebhookLeaseWithClient(client, claim.lease, now);
  const result = await client.webhookReceipt.updateMany({
    where: productWebhookClaimWhere(claim),
    data: { claimToken: claim.claimToken },
  });
  if (result.count !== 1) throw new WebhookOwnershipLostError();
}

// Root callers wrap this selection/CAS in a Serializable transaction with conflict retry.
export async function claimProductWebhookWithClient(
  client: Client,
  config: ProductWebhookConfig,
  lease: ProductWebhookLease,
  excludedShopIds: string[],
  now: Date,
) {
  await guardProductWebhookLeaseWithClient(client, lease, now);
  const row = await client.webhookReceipt.findFirst({
    where: {
      topic: { in: ["products/create", "products/update"] },
      shopId: { notIn: excludedShopIds },
      shop: { productWebhookNextAttemptAt: { lte: now } },
      OR: [
        { status: { in: ["PENDING", "RETRY"] }, nextAttemptAt: { lte: now } },
        {
          status: "PROCESSING",
          claimedAt: { lt: new Date(now.getTime() - config.claimStaleMs) },
        },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
    include: { shop: true },
  });
  if (!row) return null;
  const where = {
    id: row.id,
    status: row.status,
    claimToken: row.claimToken,
    claimedAt: row.claimedAt,
    attemptCount: row.attemptCount,
  };
  if (row.attemptCount >= config.maxAttempts) {
    const result = await client.webhookReceipt.updateMany({
      where,
      data: {
        status: "FAILED",
        claimToken: null,
        claimedAt: null,
        completedAt: now,
        lastErrorClass: "ATTEMPTS_EXHAUSTED",
      },
    });
    return result.count === 1
      ? { exhausted: true as const, shopId: row.shopId }
      : null;
  }
  const token = randomUUID();
  const result = await client.webhookReceipt.updateMany({
    where,
    data: {
      status: "PROCESSING",
      claimToken: token,
      claimedAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return {
    exhausted: false as const,
    ...row,
    status: "PROCESSING" as const,
    claimToken: token,
    claimedAt: now,
    attemptCount: row.attemptCount + 1,
    lease,
    staleRecovered: row.status === "PROCESSING",
  };
}

// Completion is executed INSIDE the product-state transaction. Any downstream failure rolls it back.
export async function completeProductWebhookWithClient(
  client: Client,
  claim: ProductWebhookClaim,
  now = new Date(),
) {
  await guardProductWebhookLeaseWithClient(client, claim.lease, now);
  const result = await client.webhookReceipt.updateMany({
    where: productWebhookClaimWhere(claim),
    data: {
      status: "COMPLETED",
      processedAt: now,
      completedAt: now,
      claimToken: null,
      claimedAt: null,
      lastErrorClass: null,
    },
  });
  if (result.count !== 1) throw new WebhookOwnershipLostError();
}

export async function failProductWebhookWithClient(
  client: Client,
  claim: ProductWebhookClaim,
  config: ProductWebhookConfig,
  error: { code: ProductWebhookErrorClass; retryable: boolean },
  now: Date,
) {
  await guardProductWebhookLeaseWithClient(client, claim.lease, now);
  const next = productWebhookFailure(
    claim.attemptCount,
    config.maxAttempts,
    error,
    now,
  );
  const result = await client.webhookReceipt.updateMany({
    where: productWebhookClaimWhere(claim),
    data: {
      ...next,
      claimToken: null,
      claimedAt: null,
      completedAt: next.status === "FAILED" ? now : null,
    },
  });
  if (result.count !== 1) throw new WebhookOwnershipLostError();
  // The shop cooldown fences OTHER pending rows too, including future worker invocations.
  if (error.retryable)
    await client.shop.update({
      where: { id: claim.shopId },
      data: { productWebhookNextAttemptAt: next.nextAttemptAt },
    });
  return next;
}
