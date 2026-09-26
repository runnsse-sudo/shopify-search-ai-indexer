import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const breadcrumbPath =
  "extensions/runn-schema-storefront/blocks/breadcrumb-schema.liquid";

const policyPath =
  "extensions/runn-schema-storefront/blocks/merchant-policy-schema.liquid";

const [breadcrumb, policy] = await Promise.all([
  readFile(breadcrumbPath, "utf8"),
  readFile(policyPath, "utf8"),
]);

function requireText(source, needle, label) {
  assert.ok(
    source.includes(needle),
    `${label}: missing required text: ${needle}`,
  );
}

function forbidText(source, needle, label) {
  assert.ok(
    !source.includes(needle),
    `${label}: forbidden text found: ${needle}`,
  );
}

// Existing breadcrumb role must remain present and isolated.
requireText(
  breadcrumb,
  'data-added-by="runn-schema-storefront"',
  "breadcrumb",
);

requireText(
  breadcrumb,
  '"@type": "BreadcrumbList"',
  "breadcrumb",
);

requireText(
  breadcrumb,
  "request.page_type == 'product'",
  "breadcrumb",
);

forbidText(
  breadcrumb,
  "runn_storefront",
  "breadcrumb",
);

forbidText(
  breadcrumb,
  "app.metafields",
  "breadcrumb",
);

// The policy writer must read Storefront Settings V1 from
// the app-owned metafield while preserving the legacy page roles.
const requiredPolicyText = [
  'data-added-by="runn-schema-storefront"',
  "app.metafields.runn_storefront.config_v1",
  "runn_config_metafield.value",
  "runn_config.version == 1",
  "runn_has_config_metafield = false",
  "{% elsif runn_has_config_metafield == false %}",

  "/pages/leveransinfo",
  "/policies/shipping-policy",
  "/policies/refund-policy",
  "runn_shipping_page_candidate",
  "runn_return_page_candidate",

  "runn_config.shipping.enabled",
  "runn_config.shipping.country",
  "runn_config.shipping.currency",
  "runn_config.shipping.rate",
  "runn_config.shipping.label",

  "runn_config.returns.enabled",
  "runn_config.returns.country",
  "runn_config.returns.periodDays",
  "runn_config.returns.method == 'ReturnByMail'",
  "runn_config.returns.fees == 'CustomerResponsibility'",
  "runn_config.returns.refundType == 'FullRefund'",
  "runn_config.returns.policyUrl",

  "assign runn_shipping_country = 'SE'",
  "assign runn_shipping_currency = 'SEK'",
  "assign runn_shipping_rate = 49",
  "assign runn_shipping_label = 'Standardfrakt Sverige'",
  "assign runn_return_country = 'SE'",
  "assign runn_return_days = 14",

  '"@type": "OnlineStore"',
  "/#online-store",

  '"hasShippingService"',
  '"@type": "ShippingService"',
  "/#shipping-standard-",
  '"name": {{ runn_shipping_label | json }}',
  '"@type": "ShippingConditions"',
  '"addressCountry": {{ runn_shipping_country | json }}',
  '"value": {{ runn_shipping_rate | json }}',
  '"currency": {{ runn_shipping_currency | json }}',

  '"hasMerchantReturnPolicy"',
  '"@type": "MerchantReturnPolicy"',
  "/#return-policy-",
  '"applicableCountry": {{ runn_return_country | json }}',
  '"returnPolicyCountry": {{ runn_return_country | json }}',
  '"returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow"',
  '"merchantReturnDays": {{ runn_return_days | json }}',
  '"returnMethod": "https://schema.org/ReturnByMail"',
  '"returnFees": "https://schema.org/ReturnFeesCustomerResponsibility"',
  '"refundType": "https://schema.org/FullRefund"',
  '"merchantReturnLink": {{ runn_return_link | json }}',

  '"target": "body"',
  '"name": "Merchant policy schema"',
];

for (const needle of requiredPolicyText) {
  requireText(
    policy,
    needle,
    "merchant-policy",
  );
}

// The JSON-LD output itself must no longer hardcode the V1 values.
// The Swedish literals remain only as explicit legacy fallback values.
const forbiddenHardcodedOutput = [
  '"addressCountry": "SE"',
  '"value": 49',
  '"currency": "SEK"',
  '"merchantReturnDays": 14',
];

for (const needle of forbiddenHardcodedOutput) {
  forbidText(
    policy,
    needle,
    "merchant-policy",
  );
}

// The policy writer must not create another Product or Offer.
// Those roles remain owned by the existing storefront during migration.
const forbiddenPolicyText = [
  '"@type": "Product"',
  '"@type": "Offer"',
  '"@type": "OfferShippingDetails"',
  '"shippingDetails"',
  '"offers"',
  '"mpn"',
  '"sku"',
  '"validFrom"',
  '"priceValidUntil"',
  '"itemCondition"',
  '"ImageObject"',
  '"WebPage"',
  '"SpeakableSpecification"',
];

for (const needle of forbiddenPolicyText) {
  forbidText(
    policy,
    needle,
    "merchant-policy",
  );
}

// Delivery-day settings are deliberately not mapped yet.
// V1 currently stores generic delivery-day values, while shipping
// schema distinguishes handling time from transit time.
forbidText(
  policy,
  '"handlingTime"',
  "merchant-policy",
);

forbidText(
  policy,
  '"transitTime"',
  "merchant-policy",
);

forbidText(
  policy,
  '"deliveryTime"',
  "merchant-policy",
);

// The block emits only on the supported policy page families.
requireText(
  policy,
  "runn_policy_path contains '/pages/leveransinfo'",
  "merchant-policy",
);

requireText(
  policy,
  "runn_policy_path contains '/policies/shipping-policy'",
  "merchant-policy",
);

requireText(
  policy,
  "runn_policy_path contains '/policies/refund-policy'",
  "merchant-policy",
);

forbidText(
  policy,
  "/policies/terms-of-service",
  "merchant-policy",
);

// A present but unsupported/corrupt config must fail closed.
// Legacy fallback is only allowed when the metafield is absent.
requireText(
  policy,
  "{% elsif runn_has_config_metafield == false %}",
  "merchant-policy",
);

console.log("Schema storefront extension verifier: PASS");
console.log("Breadcrumb role: preserved and config-isolated");
console.log("Merchant policy role: Storefront Settings V1 aware");
console.log("Legacy fallback: metafield-absent only");
console.log("Invalid/unsupported config: fail-closed");
console.log("Product writer: absent");
console.log("Offer writer: absent");
console.log("Policy page routing: legacy shipping + standard shipping + refund");
console.log("Terms of service routing: absent");
console.log("Delivery timing mapping: intentionally deferred");
