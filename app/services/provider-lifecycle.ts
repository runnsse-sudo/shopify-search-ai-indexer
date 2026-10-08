import type { Prisma } from "@prisma/client";
import { indexNowShopReadinessReason } from "./indexnow-shop-config.ts";

export async function hasOfflineInstallationWithClient(
  client: Prisma.TransactionClient,
  domain: string,
) {
  return Boolean(
    await client.session.findFirst({
      where: { shop: domain, isOnline: false },
      select: { id: true },
    }),
  );
}

export async function isIndexNowLifecycleReadyWithClient(
  client: Prisma.TransactionClient,
  shopId: string,
  expectedHost?: string,
) {
  const config = await client.shopProviderConfig.findUnique({
    where: { shopId },
    include: { shop: { select: { domain: true, primaryDomain: true } } },
  });
  if (!config || (expectedHost && config.indexNowAllowedHost !== expectedHost))
    return false;
  if (
    indexNowShopReadinessReason({
      enabled: config.indexNowEnabled,
      primaryDomain: config.shop.primaryDomain,
      allowedHost: config.indexNowAllowedHost,
      credentialCiphertext: config.indexNowCredentialCiphertext,
      credentialIv: config.indexNowCredentialIv,
      credentialTag: config.indexNowCredentialTag,
      ownershipVerifiedAt: config.indexNowOwnershipVerifiedAt,
    }) !== null
  )
    return false;
  return hasOfflineInstallationWithClient(client, config.shop.domain);
}

export async function listInstalledIndexNowConfigsWithClient(
  client: Prisma.TransactionClient,
  limit: number,
  lastRun: "materializationLastRunAt" | "indexNowLastRunAt",
) {
  const configs = await client.shopProviderConfig.findMany({
    where: {
      indexNowEnabled: true,
      indexNowOwnershipVerifiedAt: { not: null },
    },
    include: {
      shop: { select: { id: true, domain: true, primaryDomain: true } },
    },
    orderBy: [
      { [lastRun]: { sort: "asc", nulls: "first" } },
      { shopId: "asc" },
    ],
    take: limit,
  });
  const installed = [];
  for (const config of configs) {
    if (await hasOfflineInstallationWithClient(client, config.shop.domain))
      installed.push(config);
  }
  return installed;
}

// Call inside the uninstall transaction. Never depend on webhook.session being present.
export async function revokeProviderLifecycleWithClient(
  client: Prisma.TransactionClient,
  authenticatedDomain: string,
) {
  const domain = authenticatedDomain.trim().toLowerCase();
  const shop = await client.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (shop) {
    await client.shopProviderConfig.updateMany({
      where: { shopId: shop.id },
      data: {
        indexNowEnabled: false,
        indexNowOwnershipVerifiedAt: null,
        indexNowOwnershipError: "APP_UNINSTALLED",
      },
    });
    // Preserve INTERNAL intent/history. Claimed provider work is fenced out of completion/retry.
    // An already-started HTTP request cannot be recalled; no new call may bypass the late guard.
    await client.indexQueueItem.updateMany({
      where: {
        shopId: shop.id,
        provider: "INDEXNOW",
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: {
        status: "CANCELLED",
        dedupeKey: null,
        claimedAt: null,
        completedAt: new Date(),
        lastError: "APP_UNINSTALLED",
      },
    });
  }
  await client.session.deleteMany({ where: { shop: domain } });
}
