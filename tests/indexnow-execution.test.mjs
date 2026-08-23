import assert from "node:assert/strict";
import test from "node:test";
import {
  parseIndexNowExecutionConfig,
  sanitizeIndexNowConfig,
} from "../app/services/indexnow-execution-config.ts";
import {
  INDEXNOW_ENDPOINT,
  prepareIndexNowRequest,
  submitIndexNowUrl,
} from "../app/services/indexnow-client.ts";
import { indexNowRetryDelayMs } from "../app/services/indexnow-retry.ts";
import { createIndexAttemptWithClient } from "../app/services/index-attempt.ts";
import {
  parseIndexNowInterItemDelay,
  parseIndexNowMaxItems,
  indexNowWorkerEventForOutcome,
  shouldClaimAnotherIndexNowItem,
} from "../app/services/indexnow-worker-control.ts";

const key = "example-key-123";
const url = "https://shop.example/products/item";
const keyLocation = `https://shop.example/${key}.txt`;

test("execution config defaults off and only exact true enables", () => {
  for (const value of [undefined, " true ", "TRUE", "true ", "true\n", "1"]) {
    assert.deepEqual(parseIndexNowExecutionConfig({ INDEXNOW_EXECUTION_ENABLED: value }), { enabled: false });
  }
  assert.equal(parseIndexNowExecutionConfig({
    INDEXNOW_EXECUTION_ENABLED: "true", INDEXNOW_KEY: key, INDEXNOW_KEY_LOCATION: keyLocation,
  }).enabled, true);
});

test("enabled config requires key and key location without leaking key", () => {
  assert.throws(() => parseIndexNowExecutionConfig({ INDEXNOW_EXECUTION_ENABLED: "true" }), /INDEXNOW_KEY is required/);
  assert.throws(() => parseIndexNowExecutionConfig({ INDEXNOW_EXECUTION_ENABLED: "true", INDEXNOW_KEY: key }), /INDEXNOW_KEY_LOCATION is required/);
  assert.throws(() => parseIndexNowExecutionConfig({ INDEXNOW_EXECUTION_ENABLED: "true", INDEXNOW_KEY: "short", INDEXNOW_KEY_LOCATION: "not-a-url" }), /INDEXNOW_KEY is invalid/);
  const config = parseIndexNowExecutionConfig({
    INDEXNOW_EXECUTION_ENABLED: "true", INDEXNOW_KEY: key, INDEXNOW_KEY_LOCATION: keyLocation,
  });
  assert.doesNotMatch(JSON.stringify(sanitizeIndexNowConfig(config)), new RegExp(key));
});

test("IndexNow client posts the official one-URL payload and headers", async () => {
  let call;
  const result = await submitIndexNowUrl({ url, key, keyLocation }, { fetchImpl: async (...args) => {
    call = args;
    return new Response("accepted", { status: 200 });
  } });
  assert.equal(result.successful, true);
  assert.equal(call[0], INDEXNOW_ENDPOINT);
  assert.equal(call[1].method, "POST");
  assert.deepEqual(call[1].headers, { "Content-Type": "application/json; charset=utf-8" });
  assert.deepEqual(JSON.parse(call[1].body), { host: "shop.example", key, keyLocation, urlList: [url] });
});

for (const [status, successful, retryable] of [
  [200, true, false], [202, true, false], [400, false, false], [403, false, false],
  [422, false, false], [429, false, true], [500, false, true], [503, false, true],
  [418, false, false], [302, false, false],
]) {
  test(`IndexNow HTTP ${status} classification is deterministic`, async () => {
    const result = await submitIndexNowUrl({ url, key, keyLocation }, {
      fetchImpl: async () => new Response("result", { status }),
    });
    assert.equal(result.successful, successful);
    assert.equal(result.retryable, retryable);
    assert.equal(result.responseCode, status);
  });
}

test("network exceptions and timeouts are retryable", async () => {
  const network = await submitIndexNowUrl({ url, key, keyLocation }, {
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(network.retryable, true);
  assert.match(network.error, /network failure/);

  const timeout = await submitIndexNowUrl({ url, key, keyLocation }, {
    timeoutMs: 1,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.error, "IndexNow request timed out");
});

test("response and error text are bounded and redact the key", async () => {
  const response = await submitIndexNowUrl({ url, key, keyLocation }, {
    fetchImpl: async () => new Response(`${key}${"x".repeat(3000)}`, { status: 400 }),
  });
  assert.ok(response.responseBody.length <= 2000);
  assert.doesNotMatch(response.responseBody, new RegExp(key));
  const network = await submitIndexNowUrl({ url, key, keyLocation }, {
    fetchImpl: async () => { throw new Error(`secret ${key}`); },
  });
  assert.doesNotMatch(network.error, new RegExp(key));
});

test("ROOT is accepted while scoped, host mismatch, and bad HTTPS fail before fetch", async () => {
  assert.equal(prepareIndexNowRequest({ url, key, keyLocation }).host, "shop.example");
  for (const invalid of [
    { url, key, keyLocation: `https://shop.example/catalog/${key}.txt` },
    { url, key, keyLocation: `https://other.example/${key}.txt` },
    { url: "http://shop.example/products/item", key, keyLocation },
    { url, key, keyLocation: "not-a-url" },
  ]) {
    let calls = 0;
    await assert.rejects(submitIndexNowUrl(invalid, { fetchImpl: async () => { calls += 1; return new Response(); } }));
    assert.equal(calls, 0);
  }
});

test("retry backoff is deterministic and capped at 30 minutes", () => {
  assert.equal(indexNowRetryDelayMs(0), 60_000);
  assert.equal(indexNowRetryDelayMs(2), 240_000);
  assert.equal(indexNowRetryDelayMs(20), 1_800_000);
});

test("IndexAttempt numbers increase and unique races retry deterministically", async () => {
  let max = 1;
  let creates = 0;
  const client = { indexAttempt: {
    aggregate: async () => ({ _max: { attemptNumber: max } }),
    create: async ({ data }) => {
      creates += 1;
      if (creates === 1) { max = 2; throw { code: "P2002" }; }
      return data;
    },
  } };
  const result = await createIndexAttemptWithClient(client, {
    shopId: "shop-1", queueItemId: "queue-1", provider: "INDEXNOW", successful: true,
    responseCode: 200, responseBody: null, error: null, startedAt: new Date(0), completedAt: new Date(1),
  }, (error) => error?.code === "P2002");
  assert.equal(result.attemptNumber, 3);
  assert.equal(creates, 2);
});

test("worker controls are bounded and stop prevents another claim", () => {
  assert.equal(parseIndexNowMaxItems(undefined), 1);
  assert.equal(parseIndexNowMaxItems("100"), 100);
  assert.throws(() => parseIndexNowMaxItems("0"));
  assert.throws(() => parseIndexNowMaxItems("101"));
  assert.equal(parseIndexNowInterItemDelay(undefined), 500);
  assert.equal(parseIndexNowInterItemDelay("0"), 0);
  assert.throws(() => parseIndexNowInterItemDelay("-1"));
  assert.equal(shouldClaimAnotherIndexNowItem(true, 0, 1), false);
  assert.equal(shouldClaimAnotherIndexNowItem(false, 1, 1), false);
  assert.equal(indexNowWorkerEventForOutcome("completed"), "indexnow_attempt_completed");
  assert.equal(indexNowWorkerEventForOutcome("retryable_failure"), "indexnow_attempt_retryable_failure");
  assert.equal(indexNowWorkerEventForOutcome("terminal_failure"), "indexnow_attempt_terminal_failure");
  assert.equal(indexNowWorkerEventForOutcome("rejected"), "indexnow_item_rejected");
});
