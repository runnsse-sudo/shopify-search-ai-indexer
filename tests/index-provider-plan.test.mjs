import assert from "node:assert/strict";
import test from "node:test";

import { INDEX_PROVIDER_CAPABILITIES } from "../app/services/index-provider-capabilities.ts";
import { planProductPush } from "../app/services/index-provider-plan.ts";

const url = "https://shop.example/products/widget";

function plan(overrides = {}) {
  return planProductPush({ sourceProvider: "INTERNAL", action: "INDEX", url, ...overrides });
}

test("capability matrix identifies INTERNAL as source intent only", () => {
  assert.deepEqual(INDEX_PROVIDER_CAPABILITIES.INTERNAL.supportedActions, []);
  assert.equal(INDEX_PROVIDER_CAPABILITIES.INTERNAL.externallyExecutable, false);
});

test("capability matrix makes INDEXNOW the only default product push target", () => {
  const defaults = Object.entries(INDEX_PROVIDER_CAPABILITIES)
    .filter(([, capability]) => capability.defaultProductPushTarget)
    .map(([provider]) => provider);
  assert.deepEqual(defaults, ["INDEXNOW"]);
});

test("default INDEX plan emits only INDEXNOW", () => {
  assert.deepEqual(plan().targets, [{ provider: "INDEXNOW", action: "INDEX", url }]);
});

test("default DEINDEX plan emits only INDEXNOW", () => {
  assert.deepEqual(plan({ action: "DEINDEX" }).targets, [
    { provider: "INDEXNOW", action: "DEINDEX", url },
  ]);
});

test("explicit BING adds BING to an INDEX plan in deterministic order", () => {
  assert.deepEqual(plan({ explicitlyEnabledProviders: ["BING"] }).targets, [
    { provider: "INDEXNOW", action: "INDEX", url },
    { provider: "BING", action: "INDEX", url },
  ]);
});

test("explicit BING is skipped for DEINDEX with a deterministic reason", () => {
  const result = plan({ action: "DEINDEX", explicitlyEnabledProviders: ["BING"] });
  assert.deepEqual(result.targets, [{ provider: "INDEXNOW", action: "DEINDEX", url }]);
  assert.deepEqual(result.skipped, [{ provider: "BING", reason: "ACTION_UNSUPPORTED" }]);
});

test("GOOGLE is never emitted as product push work", () => {
  const result = plan({ explicitlyEnabledProviders: ["GOOGLE"] });
  assert.equal(result.targets.some(({ provider }) => provider === "GOOGLE"), false);
  assert.deepEqual(result.skipped, [
    { provider: "GOOGLE", reason: "GOOGLE_PRODUCT_PUSH_UNSUPPORTED" },
  ]);
});

test("AI_AUDIT is never emitted as product push work", () => {
  const result = plan({ explicitlyEnabledProviders: ["AI_AUDIT"] });
  assert.equal(result.targets.some(({ provider }) => provider === "AI_AUDIT"), false);
  assert.deepEqual(result.skipped, [
    { provider: "AI_AUDIT", reason: "AI_AUDIT_IS_NOT_PRODUCT_PUSH" },
  ]);
});

test("INTERNAL cannot be emitted as its own downstream target", () => {
  const result = plan({ explicitlyEnabledProviders: ["INTERNAL"] });
  assert.equal(result.targets.some(({ provider }) => provider === "INTERNAL"), false);
  assert.deepEqual(result.skipped, [
    { provider: "INTERNAL", reason: "INTERNAL_IS_SOURCE_INTENT_ONLY" },
  ]);
});

test("non-INTERNAL source intents are rejected", () => {
  assert.deepEqual(plan({ sourceProvider: "INDEXNOW" }), {
    rejectionReason: "SOURCE_PROVIDER_NOT_INTERNAL",
    targets: [],
    skipped: [],
  });
});

test("null URL is rejected", () => {
  assert.equal(plan({ url: null }).rejectionReason, "URL_REQUIRED");
});

test("malformed URL is rejected", () => {
  assert.equal(plan({ url: "not a URL" }).rejectionReason, "URL_INVALID");
});

test("non-HTTPS URL is rejected", () => {
  assert.equal(plan({ url: "http://shop.example/products/widget" }).rejectionReason, "URL_NOT_HTTPS");
});

test("duplicate explicit providers do not produce duplicate targets", () => {
  const result = plan({ explicitlyEnabledProviders: ["BING", "INDEXNOW", "BING"] });
  assert.deepEqual(result.targets.map(({ provider }) => provider), ["INDEXNOW", "BING"]);
});

test("provider input order does not affect target or skip ordering", () => {
  const first = plan({ explicitlyEnabledProviders: ["AI_AUDIT", "BING", "GOOGLE"] });
  const second = plan({ explicitlyEnabledProviders: ["GOOGLE", "AI_AUDIT", "BING"] });
  assert.deepEqual(first, second);
});
