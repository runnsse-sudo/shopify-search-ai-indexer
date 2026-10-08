import prisma from "../db.server";
import { hasOfflineInstallationWithClient, listInstalledIndexNowConfigsWithClient } from "./provider-lifecycle";
import { PublicFetchError, sanitizeOwnershipError, type PublicResolver } from "./public-fetch";
import { runSerializableTransactionWithRetry } from "./serializable-transaction-retry.server";

import {
  decryptProviderCredential,
  encryptProviderCredential,
} from "./provider-config-crypto";
import {
  buildIndexNowRootKeyLocation,
  generateIndexNowKey,
  fetchIndexNowOwnershipFile,
  indexNowShopReadinessReason,
  normalizeIndexNowHost,
  validateIndexNowCredentialPayload,
  type IndexNowCredentialPayload,
} from "./indexnow-shop-config";

function masterKey(
  env: Record<string, string | undefined>,
) {
  return env.PROVIDER_CONFIG_MASTER_KEY;
}

function storedCredential(
  config: {
    indexNowCredentialCiphertext: string | null;
    indexNowCredentialIv: string | null;
    indexNowCredentialTag: string | null;
  },
) {
  if (
    !config.indexNowCredentialCiphertext ||
    !config.indexNowCredentialIv ||
    !config.indexNowCredentialTag
  ) {
    throw new Error(
      "IndexNow credentials are not configured",
    );
  }

  return {
    ciphertext:
      config.indexNowCredentialCiphertext,
    iv:
      config.indexNowCredentialIv,
    tag:
      config.indexNowCredentialTag,
  };
}

function decryptPayload(
  config: {
    indexNowAllowedHost: string | null;
    indexNowCredentialCiphertext: string | null;
    indexNowCredentialIv: string | null;
    indexNowCredentialTag: string | null;
  },
  env: Record<string, string | undefined>,
) {
  if (!config.indexNowAllowedHost) {
    throw new Error(
      "IndexNow allowed host is not configured",
    );
  }

  const plaintext =
    decryptProviderCredential(
      storedCredential(config),
      masterKey(env),
    );

  let payload: IndexNowCredentialPayload;

  try {
    payload =
      JSON.parse(
        plaintext,
      ) as IndexNowCredentialPayload;
  } catch {
    throw new Error(
      "Stored IndexNow credential payload is invalid",
    );
  }

  return validateIndexNowCredentialPayload(
    payload,
    config.indexNowAllowedHost,
  );
}

function readinessReason(
  shop: {
    primaryDomain: string | null;
  },
  config: {
    indexNowEnabled: boolean;
    indexNowAllowedHost: string | null;
    indexNowCredentialCiphertext: string | null;
    indexNowCredentialIv: string | null;
    indexNowCredentialTag: string | null;
    indexNowOwnershipVerifiedAt: Date | null;
  },
) {
  return indexNowShopReadinessReason({
    enabled:
      config.indexNowEnabled,
    primaryDomain:
      shop.primaryDomain,
    allowedHost:
      config.indexNowAllowedHost,
    credentialCiphertext:
      config.indexNowCredentialCiphertext,
    credentialIv:
      config.indexNowCredentialIv,
    credentialTag:
      config.indexNowCredentialTag,
    ownershipVerifiedAt:
      config.indexNowOwnershipVerifiedAt,
  });
}

export async function getIndexNowShopStatus(
  shopDomain: string,
) {
  const shop =
    await prisma.shop.findUnique({
      where: {
        domain:
          shopDomain
            .trim()
            .toLowerCase(),
      },
      include: {
        providerConfig: true,
      },
    });

  if (!shop) {
    return {
      shopFound: false,
      primaryDomain: null,
      configured: false,
      enabled: false,
      ownershipVerified: false,
      ownershipVerifiedAt: null,
      ownershipLastCheckedAt: null,
      ownershipError: null,
      allowedHost: null,
      readinessReason:
        "SHOP_NOT_FOUND",
    };
  }

  const config =
    shop.providerConfig;

  if (!config) {
    return {
      shopFound: true,
      primaryDomain:
        shop.primaryDomain,
      configured: false,
      enabled: false,
      ownershipVerified: false,
      ownershipVerifiedAt: null,
      ownershipLastCheckedAt: null,
      ownershipError: null,
      allowedHost: null,
      readinessReason:
        "INDEXNOW_DISABLED",
    };
  }

  return {
    shopFound: true,
    primaryDomain:
      shop.primaryDomain,

    configured:
      Boolean(
        config.indexNowAllowedHost &&
        config.indexNowCredentialCiphertext &&
        config.indexNowCredentialIv &&
        config.indexNowCredentialTag,
      ),

    enabled:
      config.indexNowEnabled,

    ownershipVerified:
      Boolean(
        config.indexNowOwnershipVerifiedAt,
      ),

    ownershipVerifiedAt:
      config.indexNowOwnershipVerifiedAt
        ?.toISOString() ?? null,

    ownershipLastCheckedAt:
      config.indexNowOwnershipLastCheckedAt
        ?.toISOString() ?? null,

    ownershipError:
      config.indexNowOwnershipError,

    allowedHost:
      config.indexNowAllowedHost,

    readinessReason: await hasOfflineInstallationWithClient(prisma, shop.domain)
      ? readinessReason(shop, config) : "APP_NOT_INSTALLED",
  };
}

export async function prepareIndexNowShopSetup(
  shopDomain: string,
  env:
    Record<string, string | undefined> =
      process.env,
) {
  const normalizedShop =
    shopDomain
      .trim()
      .toLowerCase();

  const shop =
    await prisma.shop.findUnique({
      where: {
        domain:
          normalizedShop,
      },
      select: {
        id: true,
        domain: true,
        primaryDomain: true,
      },
    });

  if (!shop) {
    throw new Error(
      "Shop is not configured",
    );
  }

  if (!shop.primaryDomain) {
    throw new Error(
      "Shop primary domain is not available",
    );
  }

  const allowedHost =
    normalizeIndexNowHost(
      shop.primaryDomain,
    );

  const key =
    generateIndexNowKey();

  const keyLocation =
    buildIndexNowRootKeyLocation(
      allowedHost,
      key,
    );

  const payload:
    IndexNowCredentialPayload = {
      version: 1,
      key,
      keyLocation,
    };

  const encrypted =
    encryptProviderCredential(
      JSON.stringify(payload),
      masterKey(env),
    );

  await prisma.shopProviderConfig.upsert({
    where: {
      shopId:
        shop.id,
    },

    create: {
      shopId:
        shop.id,

      indexNowEnabled:
        false,

      indexNowAllowedHost:
        allowedHost,

      indexNowCredentialCiphertext:
        encrypted.ciphertext,

      indexNowCredentialIv:
        encrypted.iv,

      indexNowCredentialTag:
        encrypted.tag,

      indexNowOwnershipVerifiedAt:
        null,

      indexNowOwnershipLastCheckedAt:
        null,

      indexNowOwnershipError:
        null,

      materializationLastRunAt:
        null,

      indexNowLastRunAt:
        null,
    },

    update: {
      indexNowEnabled:
        false,

      indexNowAllowedHost:
        allowedHost,

      indexNowCredentialCiphertext:
        encrypted.ciphertext,

      indexNowCredentialIv:
        encrypted.iv,

      indexNowCredentialTag:
        encrypted.tag,

      indexNowOwnershipVerifiedAt:
        null,

      indexNowOwnershipLastCheckedAt:
        null,

      indexNowOwnershipError:
        null,

      materializationLastRunAt:
        null,

      indexNowLastRunAt:
        null,
    },
  });

  return {
    shopDomain:
      shop.domain,
    allowedHost,
    key,
    keyLocation,
  };
}

export async function verifyIndexNowShopOwnership(
  shopDomain: string,
  options: {
    env?:
      Record<string, string | undefined>;

    fetchImpl?:
      typeof fetch;
    resolve?: PublicResolver;
  } = {},
) {
  const env =
    options.env ??
    process.env;

  const fetchImpl =
    options.fetchImpl ??
    fetch;

  const shop =
    await prisma.shop.findUnique({
      where: {
        domain:
          shopDomain
            .trim()
            .toLowerCase(),
      },

      include: {
        providerConfig:
          true,
      },
    });

  if (
    !shop ||
    !shop.providerConfig
  ) {
    throw new Error(
      "IndexNow setup has not been prepared",
    );
  }

  const config =
    shop.providerConfig;

  const now =
    new Date();

  try {
    const payload =
      decryptPayload(
        config,
        env,
      );

    if (!shop.primaryDomain) {
      throw new Error(
        "Shop primary domain is missing",
      );
    }

    const primaryDomain =
      normalizeIndexNowHost(
        shop.primaryDomain,
      );

    if (
      payload.allowedHost !==
      primaryDomain
    ) {
      throw new Error(
        "Shop primary domain changed after IndexNow setup",
      );
    }

    await fetchIndexNowOwnershipFile(payload, { fetchImpl, resolve: options.resolve });
    // Do not resurrect verification revoked while the public fetch was running.
    await runSerializableTransactionWithRetry(() => prisma.$transaction(async (tx) => {
      if (!await hasOfflineInstallationWithClient(tx, shop.domain)) throw new PublicFetchError("PROVIDER_LIFECYCLE_NOT_READY");
      const saved = await tx.shopProviderConfig.updateMany({
        where: { shopId: shop.id, updatedAt: config.updatedAt },
        data: { indexNowOwnershipLastCheckedAt: now, indexNowOwnershipVerifiedAt: now, indexNowOwnershipError: null },
      });
      if (saved.count !== 1) throw new PublicFetchError("PROVIDER_LIFECYCLE_NOT_READY");
    }, { isolationLevel: "Serializable" }));

    return {
      verified: true,
      verifiedAt:
        now.toISOString(),

      allowedHost:
        payload.allowedHost,
    };
  } catch (error) {
    const safeError =
      sanitizeOwnershipError(error);

    // An obsolete result must not disable a newer setup or rewrite revocation.
    await runSerializableTransactionWithRetry(() => prisma.$transaction(async (tx) => {
      if (!await hasOfflineInstallationWithClient(tx, shop.domain)) return;
      await tx.shopProviderConfig.updateMany({
        where: {
          shopId:
            shop.id,
          updatedAt: config.updatedAt,
        },

        data: {
          indexNowEnabled:
            false,

          indexNowOwnershipLastCheckedAt:
            now,

          indexNowOwnershipVerifiedAt:
            null,

          indexNowOwnershipError:
            safeError,
        },
      });
    }, { isolationLevel: "Serializable" }));

    throw new Error(
      safeError,
    );
  }
}

export async function setIndexNowShopEnabled(
  shopDomain: string,
  enabled: boolean,
  env:
    Record<string, string | undefined> =
      process.env,
) {
  const shop =
    await prisma.shop.findUnique({
      where: {
        domain:
          shopDomain
            .trim()
            .toLowerCase(),
      },

      include: {
        providerConfig:
          true,
      },
    });

  if (
    !shop ||
    !shop.providerConfig
  ) {
    throw new Error(
      "IndexNow setup has not been prepared",
    );
  }

  if (!enabled) {
    await prisma.shopProviderConfig.update({
      where: {
        shopId:
          shop.id,
      },

      data: {
        indexNowEnabled:
          false,
      },
    });

    return getIndexNowShopStatus(
      shop.domain,
    );
  }

  const config =
    shop.providerConfig;

  if (
    !config.indexNowOwnershipVerifiedAt
  ) {
    throw new Error(
      "IndexNow ownership must be verified before enabling the provider",
    );
  }

  if (
    !shop.primaryDomain ||
    !config.indexNowAllowedHost
  ) {
    throw new Error(
      "IndexNow domain configuration is incomplete",
    );
  }

  const primaryDomain =
    normalizeIndexNowHost(
      shop.primaryDomain,
    );

  const allowedHost =
    normalizeIndexNowHost(
      config.indexNowAllowedHost,
    );

  if (
    primaryDomain !==
    allowedHost
  ) {
    throw new Error(
      "Shop primary domain changed after IndexNow verification",
    );
  }

  decryptPayload(
    config,
    env,
  );

  await runSerializableTransactionWithRetry(() => prisma.$transaction(async (tx) => {
    if (!await hasOfflineInstallationWithClient(tx, shop.domain)) throw new Error("APP_NOT_INSTALLED");
    const changed = await tx.shopProviderConfig.updateMany({
      where: { shopId: shop.id, updatedAt: config.updatedAt, indexNowOwnershipVerifiedAt: config.indexNowOwnershipVerifiedAt },
      data: { indexNowEnabled: true, indexNowOwnershipError: null },
    });
    if (changed.count !== 1) throw new Error("PROVIDER_LIFECYCLE_CHANGED");
  }, { isolationLevel: "Serializable" }));

  return getIndexNowShopStatus(
    shop.domain,
  );
}

export async function listReadyIndexNowShopsForMaterialization(
  limit: number,
) {
  const configs = await runSerializableTransactionWithRetry(() => prisma.$transaction(
    (tx) => listInstalledIndexNowConfigsWithClient(tx, limit, "materializationLastRunAt"),
    { isolationLevel: "Serializable" },
  ));

  const ready = [];

  for (const config of configs) {
    if (
      readinessReason(
        config.shop,
        config,
      ) !== null
    ) {
      continue;
    }

    ready.push({
      shopId:
        config.shop.id,

      domain:
        config.shop.domain,

      primaryDomain:
        config.shop.primaryDomain!,

      allowedHost:
        config.indexNowAllowedHost!,
    });
  }

  return ready;
}

export async function listReadyIndexNowShopsForExecution(
  limit: number,
) {
  const configs = await runSerializableTransactionWithRetry(() => prisma.$transaction(
    (tx) => listInstalledIndexNowConfigsWithClient(tx, limit, "indexNowLastRunAt"),
    { isolationLevel: "Serializable" },
  ));

  const ready = [];

  for (const config of configs) {
    if (
      readinessReason(
        config.shop,
        config,
      ) !== null
    ) {
      continue;
    }

    ready.push({
      shopId:
        config.shop.id,

      domain:
        config.shop.domain,

      allowedHost:
        config.indexNowAllowedHost!,
    });
  }

  return ready;
}

export async function getReadyIndexNowRuntimeConfig(
  shopId: string,
  env:
    Record<string, string | undefined> =
      process.env,
) {
  return runSerializableTransactionWithRetry(() => prisma.$transaction(async (tx) => {
    const config =
      await tx.shopProviderConfig.findUnique({
        where: {
          shopId,
        },

        include: {
          shop: {
            select: {
              id: true,
              domain: true,
              primaryDomain: true,
            },
          },
        },
      });

    if (!config) {
      return null;
    }

    if (
      readinessReason(
        config.shop,
        config,
      ) !== null
    ) {
      return null;
    }

    if (!await hasOfflineInstallationWithClient(tx, config.shop.domain)) return null;

    const payload =
      decryptPayload(
        config,
        env,
      );

    return {
      shopId:
        config.shop.id,

      domain:
        config.shop.domain,

      allowedHost:
        payload.allowedHost,

      key:
        payload.key,

      keyLocation:
        payload.keyLocation,
    };
  }, { isolationLevel: "Serializable" }));
}

export async function markIndexNowMaterializationRun(
  shopId: string,
  at = new Date(),
) {
  await prisma.shopProviderConfig.update({
    where: {
      shopId,
    },

    data: {
      materializationLastRunAt:
        at,
    },
  });
}

export async function markIndexNowProviderRun(
  shopId: string,
  at = new Date(),
) {
  await prisma.shopProviderConfig.update({
    where: {
      shopId,
    },

    data: {
      indexNowLastRunAt:
        at,
    },
  });
}
