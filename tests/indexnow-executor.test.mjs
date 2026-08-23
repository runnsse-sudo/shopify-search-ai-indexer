import assert from "node:assert/strict";
import test from "node:test";
import { executeOneIndexNowItem } from "../app/services/indexnow-executor.server.ts";

const key = "example-key-123";
const enabledEnv = {
  INDEXNOW_EXECUTION_ENABLED: "true",
  INDEXNOW_KEY: key,
  INDEXNOW_KEY_LOCATION: `https://shop.example/${key}.txt`,
};
const token = new Date("2026-08-22T10:00:00Z");
const item = {
  id: "queue-1", shopId: "shop-1", productIndexStateId: null,
  shopifyProductGid: "gid://shopify/Product/1", url: "https://shop.example/products/item",
  provider: "INDEXNOW", action: "INDEX", status: "PROCESSING", reason: "UPDATED",
  dedupeKey: null, retryCount: 0, maxRetries: 5, nextAttemptAt: token, claimedAt: token,
  completedAt: null, lastError: null, createdAt: token, updatedAt: token,
};

function harness(overrides = {}) {
  const calls = { recover: [], claim: [], invoke: [], attempt: [], complete: [], fail: [], beforeInvoke: [] };
  const dependencies = {
    resolveShopId: async () => "shop-1",
    recover: async (input) => { calls.recover.push(input); },
    claim: async (...args) => { calls.claim.push(args); return item; },
    invoke: async (request) => { calls.invoke.push(request); return { successful: true, retryable: false, responseCode: 200, responseBody: "ok", error: null }; },
    createAttempt: async (input) => { calls.attempt.push(input); return { attemptNumber: calls.attempt.length }; },
    complete: async (...args) => { calls.complete.push(args); return { outcome: "completed" }; },
    fail: async (...args) => { calls.fail.push(args); return { outcome: "updated" }; },
    now: (() => { let value = 0; return () => new Date(value++); })(),
    beforeInvoke: async (details) => { calls.beforeInvoke.push(details); },
    ...overrides,
  };
  return { calls, dependencies };
}

test("disabled gate and invalid config do not recover or claim", async () => {
  const disabled = harness();
  assert.deepEqual(await executeOneIndexNowItem({}, disabled.dependencies), { outcome: "disabled" });
  assert.equal(disabled.calls.claim.length, 0);
  assert.equal(disabled.calls.recover.length, 0);
  const invalid = harness();
  await assert.rejects(executeOneIndexNowItem({ INDEXNOW_EXECUTION_ENABLED: "true" }, invalid.dependencies));
  assert.equal(invalid.calls.claim.length, 0);
});

test("no work is clean and claim is restricted to INDEXNOW", async () => {
  const h = harness({ claim: async (...args) => { h.calls.claim.push(args); return null; } });
  assert.equal((await executeOneIndexNowItem(enabledEnv, h.dependencies)).outcome, "no_work");
  assert.deepEqual(h.calls.claim[0], ["INDEXNOW", undefined]);
});

for (const status of [200, 202]) {
  test(`${status} creates one attempt and completes with exact claim token`, async () => {
    const h = harness({ invoke: async (request) => { h.calls.invoke.push(request); return { successful: true, retryable: false, responseCode: status, responseBody: null, error: null }; } });
    const result = await executeOneIndexNowItem(enabledEnv, h.dependencies);
    assert.equal(result.outcome, "completed");
    assert.equal(h.calls.invoke.length, 1);
    assert.equal(h.calls.beforeInvoke.length, 1);
    assert.equal(h.calls.attempt.length, 1);
    assert.deepEqual(h.calls.complete[0], ["queue-1", token]);
    assert.equal(h.calls.fail.length, 0);
  });
}

test("both INDEX and DEINDEX actions execute successfully", async () => {
  for (const action of ["INDEX", "DEINDEX"]) {
    const h = harness({ claim: async () => ({ ...item, action }) });
    const result = await executeOneIndexNowItem(enabledEnv, h.dependencies);
    assert.equal(result.outcome, "completed");
    assert.equal(h.calls.invoke.length, 1);
    assert.equal(h.calls.attempt.length, 1);
  }
});

for (const [name, clientResult, expected, terminal] of [
  ["429", { successful: false, retryable: true, responseCode: 429, responseBody: null, error: "rate limited" }, "retryable_failure", false],
  ["5xx", { successful: false, retryable: true, responseCode: 503, responseBody: null, error: "unavailable" }, "retryable_failure", false],
  ["network", { successful: false, retryable: true, responseCode: null, responseBody: null, error: "network failure" }, "retryable_failure", false],
  ["400", { successful: false, retryable: false, responseCode: 400, responseBody: null, error: "bad request" }, "terminal_failure", true],
  ["403", { successful: false, retryable: false, responseCode: 403, responseBody: null, error: "forbidden" }, "terminal_failure", true],
  ["422", { successful: false, retryable: false, responseCode: 422, responseBody: null, error: "invalid" }, "terminal_failure", true],
]) {
  test(`${name} creates one attempt and uses the expected failure path`, async () => {
    const h = harness({ invoke: async () => clientResult });
    const result = await executeOneIndexNowItem(enabledEnv, h.dependencies);
    assert.equal(result.outcome, expected);
    assert.equal(h.calls.attempt.length, 1);
    assert.equal(h.calls.fail.length, 1);
    assert.equal(h.calls.fail[0][1], token);
    assert.equal(h.calls.fail[0][4], terminal);
  });
}

test("readiness and allowed-host failures make no provider request or attempt", async () => {
  const scoped = harness();
  await assert.rejects(executeOneIndexNowItem({
    ...enabledEnv,
    INDEXNOW_KEY_LOCATION: `https://shop.example/catalog/${key}.txt`,
  }, scoped.dependencies), /root key location/);
  assert.equal(scoped.calls.claim.length, 0);

  const wrongHost = harness();
  const result = await executeOneIndexNowItem({ ...enabledEnv, INDEXNOW_ALLOWED_HOST: "other.example" }, wrongHost.dependencies);
  assert.equal(result.outcome, "rejected");
  assert.equal(wrongHost.calls.invoke.length, 0);
  assert.equal(wrongHost.calls.attempt.length, 0);
  assert.equal(wrongHost.calls.beforeInvoke.length, 0);
  assert.equal(wrongHost.calls.fail[0][4], true);
});

test("missing URL is rejected before network without an attempt or claimed notification", async () => {
  const h = harness({ claim: async () => ({ ...item, url: null }) });
  const result = await executeOneIndexNowItem(enabledEnv, h.dependencies);
  assert.equal(result.outcome, "rejected");
  assert.equal(h.calls.invoke.length, 0);
  assert.equal(h.calls.attempt.length, 0);
  assert.equal(h.calls.beforeInvoke.length, 0);
});

test("shop selector resolves before recovery and restricts both recovery and claim", async () => {
  const h = harness();
  await executeOneIndexNowItem({ ...enabledEnv, INDEXNOW_SHOP_DOMAIN: "test.myshopify.com" }, h.dependencies);
  assert.equal(h.calls.recover[0].shopId, "shop-1");
  assert.deepEqual(h.calls.claim[0], ["INDEXNOW", "shop-1"]);
  const missing = harness({ resolveShopId: async () => null });
  await assert.rejects(executeOneIndexNowItem({ ...enabledEnv, INDEXNOW_SHOP_DOMAIN: "missing" }, missing.dependencies));
  assert.equal(missing.calls.claim.length, 0);
});

test("post-claim shop scope mismatch throws safely before request or attempt", async () => {
  const h = harness({ claim: async () => ({ ...item, shopId: "shop-2" }) });
  await assert.rejects(
    executeOneIndexNowItem({ ...enabledEnv, INDEXNOW_SHOP_DOMAIN: "test.myshopify.com" }, h.dependencies),
    (error) => {
      assert.match(error.message, /outside the selected shop scope/);
      assert.doesNotMatch(error.message, new RegExp(key));
      assert.doesNotMatch(error.message, /keyLocation/i);
      return true;
    },
  );
  assert.equal(h.calls.invoke.length, 0);
  assert.equal(h.calls.attempt.length, 0);
  assert.equal(h.calls.beforeInvoke.length, 0);
});

test("claimed callback fires exactly once immediately before invocation with safe fields", async () => {
  const order = [];
  const h = harness({
    beforeInvoke: async (details) => { h.calls.beforeInvoke.push(details); order.push("claimed"); },
    invoke: async (request) => { h.calls.invoke.push(request); order.push("invoke"); return { successful: true, retryable: false, responseCode: 200, responseBody: null, error: null }; },
  });
  await executeOneIndexNowItem(enabledEnv, h.dependencies);
  assert.deepEqual(order, ["claimed", "invoke"]);
  assert.deepEqual(h.calls.beforeInvoke, [{
    queueItemId: "queue-1",
    shopId: "shop-1",
    action: "INDEX",
    host: "shop.example",
  }]);
  assert.doesNotMatch(JSON.stringify(h.calls.beforeInvoke), new RegExp(key));
  assert.doesNotMatch(JSON.stringify(h.calls.beforeInvoke), /keyLocation/);
});

test("lost ownership after request preserves attempt and does not force another mutation", async () => {
  const h = harness({ complete: async (...args) => { h.calls.complete.push(args); return { outcome: "ownership_lost", item: null }; } });
  const result = await executeOneIndexNowItem(enabledEnv, h.dependencies);
  assert.equal(result.transition.outcome, "ownership_lost");
  assert.equal(h.calls.attempt.length, 1);
  assert.equal(h.calls.complete.length, 1);
  assert.equal(h.calls.fail.length, 0);
});

test("executor redacts injected client output before IndexAttempt persistence", async () => {
  const h = harness({ invoke: async () => ({
    successful: false,
    retryable: false,
    responseCode: 403,
    responseBody: `body ${key}`,
    error: `error ${key}`,
  }) });
  await executeOneIndexNowItem(enabledEnv, h.dependencies);
  assert.doesNotMatch(h.calls.attempt[0].responseBody, new RegExp(key));
  assert.doesNotMatch(h.calls.attempt[0].error, new RegExp(key));
});

test("unsupported action and malformed claim are blocked before invocation", async () => {
  const unsupported = harness({ claim: async () => ({ ...item, action: "UNSUPPORTED" }) });
  assert.equal((await executeOneIndexNowItem(enabledEnv, unsupported.dependencies)).outcome, "rejected");
  assert.equal(unsupported.calls.invoke.length, 0);
  const missingToken = harness({ claim: async () => ({ ...item, claimedAt: null }) });
  await assert.rejects(executeOneIndexNowItem(enabledEnv, missingToken.dependencies), /ownership token/);
});
