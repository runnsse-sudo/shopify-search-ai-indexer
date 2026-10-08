/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root = "extensions/runn-schema-storefront/";
const read = (file) => readFile(root + file, "utf8");
const [breadcrumb, policy, validator, returns, shipping] = await Promise.all([
  read("blocks/breadcrumb-schema.liquid"),
  read("blocks/merchant-policy-schema.liquid"),
  read("snippets/runn-schema-config-valid.liquid"),
  read("snippets/runn-return-policy.liquid"),
  read("snippets/runn-shipping-policy.liquid"),
]);
for (const kind of ["product", "collection", "page"])
  assert.ok(breadcrumb.includes("when '" + kind + "'"));
assert.ok(breadcrumb.includes('"@type": "BreadcrumbList"'));
assert.ok(breadcrumb.includes("canonical_url | append: '#breadcrumb'"));
assert.ok(!breadcrumb.includes("app.metafields"));
assert.ok(policy.includes("app.metafields.runn_storefront.config_v1"));
assert.ok(policy.includes("runn_config_metafield.type == 'json'"));
assert.ok(validator.includes("config.version == 1"));
assert.ok(validator.includes("config.shipping.enabled == true"));
assert.ok(validator.includes("config.returns.enabled == true"));
for (const path of [
  "/pages/leveransinfo",
  "/policies/shipping-policy",
  "/policies/refund-policy",
])
  assert.ok(policy.includes(path));
assert.ok(!policy.includes("/policies/terms-of-service"));
for (const text of [
  "/#online-store",
  "runn_shipping_valid == 'true'",
  "runn_returns_valid == 'true'",
  'data-added-by="runn-schema-storefront"',
])
  assert.ok(policy.includes(text));
assert.ok(returns.includes('"@type": "MerchantReturnPolicy"'));
assert.ok(shipping.includes('"@type": "ShippingService"'));
for (const source of [policy, validator, returns, shipping]) {
  assert.ok(!source.includes("runn_has_config_metafield"));
  assert.ok(
    !/['"](?:SE|SEK)['"]|assign\s+\w+\s*=\s*(?:49|14|30)\b/.test(source),
  );
  assert.ok(!/"(?:handlingTime|transitTime|deliveryTime)"/.test(source));
}
assert.ok(!/"@type": "(?:Product|Offer)"/.test(policy + returns + shipping));
console.log("Schema storefront extension verifier: PASS");
console.log(
  "Breadcrumb: product/collection/page; policy: explicit valid config only; legacy fallback: absent",
);
