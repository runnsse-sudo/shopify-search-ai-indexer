import prisma from "../db.server";

import {
  decryptProviderCredential,
  encryptProviderCredential,
} from "./provider-config-crypto";
import {
  buildIndexNowRootKeyLocation,
  generateIndexNowKey,
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

    readinessReason:
      readinessReason(
        shop,
        config,
      ),
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

    const response =
      await fetchImpl(
        payload.keyLocation,
        {
          method: "GET",
          redirect: "follow",

          signal:
            AbortSignal.timeout(
              10000,
            ),

          headers: {
            accept:
              "text/plain,*/*;q=0.1",
          },
        },
      );

    if (!response.ok) {
      throw new Error(
        `IndexNow ownership URL returned HTTP ${response.status}`,
      );
    }

    const body =
      (await response.text())
        .replace(/^\uFEFF/, "")
        .trim();

    if (body !== payload.key) {
      throw new Error(
        "IndexNow ownership URL body does not match the configured key",
      );
    }

    await prisma.shopProviderConfig.update({
      where: {
        shopId:
          shop.id,
      },

      data: {
        indexNowOwnershipLastCheckedAt:
          now,

        indexNowOwnershipVerifiedAt:
          now,

        indexNowOwnershipError:
          null,
      },
    });

    return {
      verified: true,
      verifiedAt:
        now.toISOString(),

      allowedHost:
        payload.allowedHost,
    };
  } catch (error) {
    const safeError =
      error instanceof Error
        ? error.message.slice(0, 1000)
        : "IndexNow ownership verification failed";

    await prisma.shopProviderConfig.update({
      where: {
        shopId:
          shop.id,
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

  await prisma.shopProviderConfig.update({
    where: {
      shopId:
        shop.id,
    },

    data: {
      indexNowEnabled:
        true,

      indexNowOwnershipError:
        null,
    },
  });

  return getIndexNowShopStatus(
    shop.domain,
  );
}

export async function listReadyIndexNowShopsForMaterialization(
  limit: number,
) {
  const configs =
    await prisma.shopProviderConfig.findMany({
      where: {
        indexNowEnabled:
          true,

        indexNowOwnershipVerifiedAt: {
          not: null,
        },
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

      orderBy: [
        {
          materializationLastRunAt: {
            sort: "asc",
            nulls: "first",
          },
        },

        {
          shopId: "asc",
        },
      ],

      take:
        limit,
    });

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
  const configs =
    await prisma.shopProviderConfig.findMany({
      where: {
        indexNowEnabled:
          true,

        indexNowOwnershipVerifiedAt: {
          not: null,
        },
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

      orderBy: [
        {
          indexNowLastRunAt: {
            sort: "asc",
            nulls: "first",
          },
        },

        {
          shopId: "asc",
        },
      ],

      take:
        limit,
    });

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
  const config =
    await prisma.shopProviderConfig.findUnique({
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