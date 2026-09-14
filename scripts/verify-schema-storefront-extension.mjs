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

// New merchant-policy role.
const requiredPolicyText = [
  'data-added-by="runn-schema-storefront"',
  "/pages/leveransinfo",
  "/policies/refund-policy",
  '"@type": "OnlineStore"',
  "/#online-store",
  '"hasShippingService"',
  '"@type": "ShippingService"',
  "/#shipping-standard-se",
  '"@type": "ShippingConditions"',
  '"addressCountry": "SE"',
  '"value": 49',
  '"currency": "SEK"',
  '"hasMerchantReturnPolicy"',
  '"@type": "MerchantReturnPolicy"',
  "/#return-policy-se",
  '"applicableCountry": "SE"',
  '"returnPolicyCountry": "SE"',
  '"returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow"',
  '"merchantReturnDays": 14',
  '"returnMethod": "https://schema.org/ReturnByMail"',
  '"returnFees": "https://schema.org/ReturnFeesCustomerResponsibility"',
  '"refundType": "https://schema.org/FullRefund"',
  '"merchantReturnLink": {{ canonical_url | json }}',
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

// Do not copy autoSchema's delivery-time assumptions.
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

// The block must emit only on the two intended policy page families.
requireText(
  policy,
  "{% if runn_is_shipping_policy or runn_is_return_policy %}",
  "merchant-policy",
);

console.log("Schema storefront extension verifier: PASS");
console.log("Breadcrumb role: preserved");
console.log("Merchant policy role: present");
console.log("Product writer: absent");
console.log("Offer writer: absent");
console.log("Shipping policy: organization-level only");
console.log("Return policy: organization-level only");
console.log("autoSchema timing assumptions: not copied");
