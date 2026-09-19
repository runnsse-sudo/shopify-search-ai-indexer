import type {
  AdminGraphqlClient,
} from "./shopify-product.server";

import {
  STOREFRONT_SETTINGS_KEY,
  STOREFRONT_SETTINGS_NAMESPACE,
  STOREFRONT_SETTINGS_TYPE,
  createDefaultStorefrontSettings,
  normalizeStorefrontSettings,
  stringifyStorefrontSettings,
  type StorefrontSettings,
} from "./storefront-settings";

type GraphQlError = {
  message: string;
};

type GraphQlEnvelope<T> = {
  data?: T;
  errors?: GraphQlError[];
};

type MetafieldNode = {
  id: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
  compareDigest: string;
};

type InstallationReadData = {
  currentAppInstallation?: {
    id: string;
    metafield: MetafieldNode | null;
  } | null;
};

type InstallationOwnerData = {
  currentAppInstallation?: {
    id: string;
  } | null;
};

type MetafieldsSetData = {
  metafieldsSet?: {
    metafields: MetafieldNode[];
    userErrors: Array<{
      field?: string[] | null;
      message: string;
      code?: string | null;
    }>;
  } | null;
};

export type StorefrontSettingsSnapshot = {
  installationId: string;
  exists: boolean;
  metafieldId: string | null;
  compareDigest: string | null;
  config: StorefrontSettings;
};

async function readGraphQl<T>(
  response: Response,
  label: string,
): Promise<T> {
  const body =
    (await response.json()) as
      GraphQlEnvelope<T>;

  if (body.errors?.length) {
    throw new Error(
      `${label}: ${body.errors
        .map(
          (error) =>
            error.message,
        )
        .join("; ")}`,
    );
  }

  if (!body.data) {
    throw new Error(
      `${label}: missing GraphQL data`,
    );
  }

  return body.data;
}

function validateMetafieldIdentity(
  metafield: MetafieldNode,
) {
  if (
    metafield.namespace !==
    STOREFRONT_SETTINGS_NAMESPACE
  ) {
    throw new Error(
      "Storefront settings metafield namespace mismatch",
    );
  }

  if (
    metafield.key !==
    STOREFRONT_SETTINGS_KEY
  ) {
    throw new Error(
      "Storefront settings metafield key mismatch",
    );
  }

  if (
    metafield.type !==
    STOREFRONT_SETTINGS_TYPE
  ) {
    throw new Error(
      `Storefront settings metafield type must be ${STOREFRONT_SETTINGS_TYPE}`,
    );
  }
}

function requireCompareDigest(
  metafield: MetafieldNode,
) {
  const digest =
    metafield.compareDigest;

  if (
    typeof digest !== "string" ||
    !digest.trim()
  ) {
    throw new Error(
      "Storefront settings metafield compareDigest is unavailable",
    );
  }

  return digest;
}
function parseStoredConfig(
  metafield: MetafieldNode,
) {
  validateMetafieldIdentity(
    metafield,
  );

  let parsed: unknown;

  try {
    parsed =
      JSON.parse(
        metafield.value,
      );
  } catch {
    throw new Error(
      "Stored storefront settings contain invalid JSON",
    );
  }

  return normalizeStorefrontSettings(
    parsed,
  );
}

export async function getStorefrontSettings(
  admin: AdminGraphqlClient,
): Promise<StorefrontSettingsSnapshot> {
  const response =
    await admin.graphql(`#graphql
      query StorefrontSettingsRead {
        currentAppInstallation {
          id

          metafield(
            namespace: "runn_storefront"
            key: "config_v1"
          ) {
            id
            namespace
            key
            type
            value
            compareDigest
          }
        }
      }
    `);

  const data =
    await readGraphQl<
      InstallationReadData
    >(
      response,
      "Storefront settings read failed",
    );

  const installation =
    data.currentAppInstallation;

  if (!installation?.id) {
    throw new Error(
      "Current AppInstallation is unavailable",
    );
  }

  const metafield =
    installation.metafield;

  if (!metafield) {
    return {
      installationId:
        installation.id,

      exists:
        false,

      metafieldId:
        null,

      compareDigest:
        null,

      config:
        createDefaultStorefrontSettings(),
    };
  }

  return {
    installationId:
      installation.id,

    exists:
      true,

    metafieldId:
      metafield.id,

    compareDigest:
      requireCompareDigest(
        metafield,
      ),

    config:
      parseStoredConfig(
        metafield,
      ),
  };
}

export async function saveStorefrontSettings(
  admin: AdminGraphqlClient,
  input: unknown,
  expectedCompareDigest: string | null,
): Promise<StorefrontSettingsSnapshot> {
  const config =
    normalizeStorefrontSettings(
      input,
    );

  if (
    expectedCompareDigest !== null &&
    !expectedCompareDigest.trim()
  ) {
    throw new Error(
      "Expected compareDigest must be null or a non-empty string",
    );
  }

  const ownerResponse =
    await admin.graphql(`#graphql
      query StorefrontSettingsOwner {
        currentAppInstallation {
          id
        }
      }
    `);

  const ownerData =
    await readGraphQl<
      InstallationOwnerData
    >(
      ownerResponse,
      "Storefront settings owner lookup failed",
    );

  const installationId =
    ownerData.currentAppInstallation
      ?.id;

  if (!installationId) {
    throw new Error(
      "Current AppInstallation is unavailable",
    );
  }

  const value =
    stringifyStorefrontSettings(
      config,
    );

  const response =
    await admin.graphql(
      `#graphql
        mutation StorefrontSettingsSave(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
            metafields: $metafields
          ) {
            metafields {
              id
              namespace
              key
              type
              value
              compareDigest
            }

            userErrors {
              field
              message
              code
            }
          }
        }
      `,
      {
        variables: {
          metafields: [
            {
              ownerId:
                installationId,

              namespace:
                STOREFRONT_SETTINGS_NAMESPACE,

              key:
                STOREFRONT_SETTINGS_KEY,

              type:
                STOREFRONT_SETTINGS_TYPE,

              value,

              compareDigest:
                expectedCompareDigest,
            },
          ],
        },
      },
    );

  const data =
    await readGraphQl<
      MetafieldsSetData
    >(
      response,
      "Storefront settings save failed",
    );

  const payload =
    data.metafieldsSet;

  if (!payload) {
    throw new Error(
      "Storefront settings save returned no payload",
    );
  }

  if (
    payload.userErrors.length
  ) {
    throw new Error(
      `Storefront settings save rejected: ${payload.userErrors
        .map(
          (error) => {
            const code =
              error.code
                ? `[${error.code}] `
                : "";

            return `${code}${error.message}`;
          },
        )
        .join("; ")}`,
    );
  }

  if (
    payload.metafields.length !==
    1
  ) {
    throw new Error(
      "Storefront settings save did not return exactly one metafield",
    );
  }

  const metafield =
    payload.metafields[0];

  validateMetafieldIdentity(
    metafield,
  );

  const savedConfig =
    parseStoredConfig(
      metafield,
    );

  if (
    stringifyStorefrontSettings(
      savedConfig,
    ) !==
    value
  ) {
    throw new Error(
      "Storefront settings save response did not match the requested normalized value",
    );
  }

  return {
    installationId,

    exists:
      true,

    metafieldId:
      metafield.id,

    compareDigest:
      requireCompareDigest(
        metafield,
      ),

    config:
      savedConfig,
  };
}