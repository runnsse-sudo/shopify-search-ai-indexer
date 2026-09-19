import assert from "node:assert/strict";

import {
  createDefaultStorefrontSettings,
  normalizeStorefrontSettings,
  stringifyStorefrontSettings,
} from "../build-tests/storefront-settings.mjs";

import {
  getStorefrontSettings,
  saveStorefrontSettings,
} from "../build-tests/storefront-settings-server.mjs";

function jsonResponse(body) {
  return new Response(
    JSON.stringify(body),
    {
      status: 200,
      headers: {
        "content-type":
          "application/json",
      },
    },
  );
}

const defaults =
  createDefaultStorefrontSettings();

assert.equal(
  defaults.version,
  1,
);

assert.equal(
  defaults.shipping.enabled,
  false,
);

assert.equal(
  defaults.shipping.country,
  "SE",
);

assert.equal(
  defaults.shipping.rate,
  49,
);

assert.equal(
  defaults.shipping.currency,
  "SEK",
);

assert.equal(
  defaults.shipping.minimumDeliveryDays,
  1,
);

assert.equal(
  defaults.shipping.maximumDeliveryDays,
  3,
);

assert.equal(
  defaults.returns.enabled,
  false,
);

assert.equal(
  defaults.returns.periodDays,
  14,
);

assert.equal(
  defaults.returns.method,
  "ReturnByMail",
);

assert.equal(
  defaults.returns.fees,
  "CustomerResponsibility",
);

assert.equal(
  defaults.returns.refundType,
  "FullRefund",
);


const normalized =
  normalizeStorefrontSettings({
    ...defaults,

    identity: {
      ...defaults.identity,

      founder:
        "  Daniel Example  ",

      facebookUrl:
        "https://facebook.com/example",
    },

    shipping: {
      ...defaults.shipping,

      country:
        "se",

      currency:
        "sek",

      label:
        "  Standardfrakt Sverige  ",
    },

    returns: {
      ...defaults.returns,

      country:
        "se",
    },
  });

assert.equal(
  normalized.identity.founder,
  "Daniel Example",
);

assert.equal(
  normalized.shipping.country,
  "SE",
);

assert.equal(
  normalized.shipping.currency,
  "SEK",
);

assert.equal(
  normalized.shipping.label,
  "Standardfrakt Sverige",
);

assert.equal(
  normalized.returns.country,
  "SE",
);

assert.equal(
  normalized.identity.facebookUrl,
  "https://facebook.com/example",
);


assert.throws(
  () =>
    normalizeStorefrontSettings({
      ...defaults,

      shipping: {
        ...defaults.shipping,

        minimumDeliveryDays:
          5,

        maximumDeliveryDays:
          2,
      },
    }),
  /cannot exceed/,
);


const relativePageUrls =
  normalizeStorefrontSettings({
    ...defaults,

    identity: {
      ...defaults.identity,

      aboutUrl:
        "/pages/about",

      contactUrl:
        "/pages/contact",
    },

    shipping: {
      ...defaults.shipping,

      policyUrl:
        "/pages/leveransinformation",
    },

    returns: {
      ...defaults.returns,

      policyUrl:
        "/policies/refund-policy",
    },
  });

assert.equal(
  relativePageUrls
    .identity
    .aboutUrl,
  "/pages/about",
);

assert.equal(
  relativePageUrls
    .identity
    .contactUrl,
  "/pages/contact",
);

assert.equal(
  relativePageUrls
    .shipping
    .policyUrl,
  "/pages/leveransinformation",
);

assert.equal(
  relativePageUrls
    .returns
    .policyUrl,
  "/policies/refund-policy",
);

assert.throws(
  () =>
    normalizeStorefrontSettings({
      ...defaults,

      identity: {
        ...defaults.identity,

        aboutUrl:
          "//evil.example/pages/about",
      },
    }),
  /absolute URL/,
);


assert.throws(
  () =>
    normalizeStorefrontSettings({
      ...defaults,

      returns: {
        ...defaults.returns,

        method:
          "UnsupportedMethod",
      },
    }),
  /ReturnByMail/,
);


const missingAdmin = {
  async graphql(query) {
    assert.match(
      query,
      /StorefrontSettingsRead/,
    );

    return jsonResponse({
      data: {
        currentAppInstallation: {
          id:
            "gid://shopify/AppInstallation/1",

          metafield:
            null,
        },
      },
    });
  },
};

const missingSnapshot =
  await getStorefrontSettings(
    missingAdmin,
  );

assert.equal(
  missingSnapshot.exists,
  false,
);

assert.equal(
  missingSnapshot.compareDigest,
  null,
);

assert.deepEqual(
  missingSnapshot.config,
  defaults,
);


const existingValue =
  stringifyStorefrontSettings({
    ...defaults,

    shipping: {
      ...defaults.shipping,

      enabled:
        true,

      minimumDeliveryDays:
        2,

      maximumDeliveryDays:
        4,
    },
  });

const existingAdmin = {
  async graphql(query) {
    assert.match(
      query,
      /StorefrontSettingsRead/,
    );

    return jsonResponse({
      data: {
        currentAppInstallation: {
          id:
            "gid://shopify/AppInstallation/2",

          metafield: {
            id:
              "gid://shopify/Metafield/2",

            namespace:
              "runn_storefront",

            key:
              "config_v1",

            type:
              "json",

            value:
              existingValue,

            compareDigest:
              "digest-existing",
          },
        },
      },
    });
  },
};

const existingSnapshot =
  await getStorefrontSettings(
    existingAdmin,
  );

assert.equal(
  existingSnapshot.exists,
  true,
);

assert.equal(
  existingSnapshot.compareDigest,
  "digest-existing",
);

assert.equal(
  existingSnapshot.config
    .shipping
    .enabled,
  true,
);

assert.equal(
  existingSnapshot.config
    .shipping
    .minimumDeliveryDays,
  2,
);

assert.equal(
  existingSnapshot.config
    .shipping
    .maximumDeliveryDays,
  4,
);


const missingDigestAdmin = {
  async graphql(query) {
    assert.match(
      query,
      /StorefrontSettingsRead/,
    );

    return jsonResponse({
      data: {
        currentAppInstallation: {
          id:
            "gid://shopify/AppInstallation/digest-test",

          metafield: {
            id:
              "gid://shopify/Metafield/digest-test",

            namespace:
              "runn_storefront",

            key:
              "config_v1",

            type:
              "json",

            value:
              stringifyStorefrontSettings(
                defaults,
              ),

            compareDigest:
              null,
          },
        },
      },
    });
  },
};

await assert.rejects(
  () =>
    getStorefrontSettings(
      missingDigestAdmin,
    ),
  /compareDigest is unavailable/,
);

let mutationVariables = null;
let saveCall = 0;

const saveAdmin = {
  async graphql(query, options) {
    saveCall += 1;

    if (
      query.includes(
        "StorefrontSettingsOwner",
      )
    ) {
      assert.equal(
        saveCall,
        1,
      );

      return jsonResponse({
        data: {
          currentAppInstallation: {
            id:
              "gid://shopify/AppInstallation/3",
          },
        },
      });
    }

    assert.match(
      query,
      /StorefrontSettingsSave/,
    );

    assert.equal(
      saveCall,
      2,
    );

    mutationVariables =
      options?.variables ?? null;

    const input =
      mutationVariables
        ?.metafields?.[0];

    assert.equal(
      input.ownerId,
      "gid://shopify/AppInstallation/3",
    );

    assert.equal(
      input.namespace,
      "runn_storefront",
    );

    assert.equal(
      input.key,
      "config_v1",
    );

    assert.equal(
      input.type,
      "json",
    );

    assert.equal(
      input.compareDigest,
      "expected-digest",
    );

    const parsedValue =
      JSON.parse(
        input.value,
      );

    assert.equal(
      parsedValue.shipping.country,
      "SE",
    );

    assert.equal(
      parsedValue.shipping.currency,
      "SEK",
    );

    return jsonResponse({
      data: {
        metafieldsSet: {
          metafields: [
            {
              id:
                "gid://shopify/Metafield/3",

              namespace:
                "runn_storefront",

              key:
                "config_v1",

              type:
                "json",

              value:
                input.value,

              compareDigest:
                "new-digest",
            },
          ],

          userErrors: [],
        },
      },
    });
  },
};


const saved =
  await saveStorefrontSettings(
    saveAdmin,
    {
      ...defaults,

      shipping: {
        ...defaults.shipping,

        country:
          "se",

        currency:
          "sek",
      },
    },
    "expected-digest",
  );

assert.equal(
  saveCall,
  2,
);

assert.equal(
  saved.exists,
  true,
);

assert.equal(
  saved.compareDigest,
  "new-digest",
);

assert.equal(
  saved.config.shipping.country,
  "SE",
);


const createOnlyAdmin = {
  async graphql(query, options) {
    if (
      query.includes(
        "StorefrontSettingsOwner",
      )
    ) {
      return jsonResponse({
        data: {
          currentAppInstallation: {
            id:
              "gid://shopify/AppInstallation/4",
          },
        },
      });
    }

    const input =
      options?.variables
        ?.metafields?.[0];

    assert.equal(
      input.compareDigest,
      null,
      "A first save must preserve create-only compareDigest=null semantics.",
    );

    return jsonResponse({
      data: {
        metafieldsSet: {
          metafields: [
            {
              id:
                "gid://shopify/Metafield/4",

              namespace:
                "runn_storefront",

              key:
                "config_v1",

              type:
                "json",

              value:
                input.value,

              compareDigest:
                "created-digest",
            },
          ],

          userErrors: [],
        },
      },
    });
  },
};

const created =
  await saveStorefrontSettings(
    createOnlyAdmin,
    defaults,
    null,
  );

assert.equal(
  created.compareDigest,
  "created-digest",
);


const rejectedAdmin = {
  async graphql(query) {
    if (
      query.includes(
        "StorefrontSettingsOwner",
      )
    ) {
      return jsonResponse({
        data: {
          currentAppInstallation: {
            id:
              "gid://shopify/AppInstallation/5",
          },
        },
      });
    }

    return jsonResponse({
      data: {
        metafieldsSet: {
          metafields: [],

          userErrors: [
            {
              field: [
                "metafields",
                "0",
                "compareDigest",
              ],

              message:
                "The metafield has been modified.",

              code:
                "STALE_OBJECT",
            },
          ],
        },
      },
    });
  },
};

await assert.rejects(
  () =>
    saveStorefrontSettings(
      rejectedAdmin,
      defaults,
      "stale-digest",
    ),
  /STALE_OBJECT/,
);


console.log(
  "STOREFRONT_SETTINGS_VERIFICATION=PASS",
);

console.log(
  JSON.stringify(
    {
      defaults: {
        shipping:
          defaults.shipping,

        returns:
          defaults.returns,
      },

      normalized: {
        founder:
          normalized.identity.founder,

        shippingCountry:
          normalized.shipping.country,

        shippingCurrency:
          normalized.shipping.currency,
      },

      read: {
        missingMetafield:
          missingSnapshot.exists,

        existingMetafield:
          existingSnapshot.exists,

        existingDigest:
          existingSnapshot.compareDigest,
      },

      save: {
        updateDigest:
          saved.compareDigest,

        createDigest:
          created.compareDigest,

        staleWriteRejected:
          true,
      },
    },
    null,
    2,
  ),
);