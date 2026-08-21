import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireWebhookReceiptWithClient,
  runWithWebhookReceipt,
} from "../app/services/webhook-idempotency.server.ts";
import { requireShopifyWebhookId } from "../app/services/webhook-metadata.ts";

const identity = {
  shopId: "shop-1",
  webhookId: "webhook-1",
  eventId: "event-shared-by-audit-only",
  topic: "products/update",
  shopifyProductGid: "gid://shopify/Product/123",
  triggeredAt: "2026-08-21T10:00:00Z",
};

function transactionReturning(count) {
  const calls = [];
  return {
    calls,
    webhookReceipt: {
      createMany: async (args) => {
        calls.push(args);
        return { count };
      },
    },
  };
}

test("receipt create count 1 acquires and preserves all audit fields", async () => {
  const tx = transactionReturning(1);
  assert.equal(await acquireWebhookReceiptWithClient(tx, identity), "ACQUIRED");
  assert.deepEqual(tx.calls, [{ data: identity, skipDuplicates: true }]);
});

test("receipt create count 0 reports duplicate", async () => {
  const tx = transactionReturning(0);
  assert.equal(await acquireWebhookReceiptWithClient(tx, identity), "DUPLICATE");
});

test("shop and webhook IDs are the receipt identity while event ID remains audit data", async () => {
  const tx = transactionReturning(1);
  await acquireWebhookReceiptWithClient(tx, { ...identity, eventId: "event-can-repeat" });
  assert.equal(tx.calls[0].data.shopId, "shop-1");
  assert.equal(tx.calls[0].data.webhookId, "webhook-1");
  assert.equal(tx.calls[0].data.eventId, "event-can-repeat");
  assert.equal(tx.calls[0].skipDuplicates, true);
});

test("acquired receipt runs downstream work", async () => {
  const tx = transactionReturning(1);
  let workCalls = 0;
  const result = await runWithWebhookReceipt(tx, identity, async () => {
    workCalls += 1;
    return "processed";
  });
  assert.equal(workCalls, 1);
  assert.deepEqual(result, { duplicateWebhook: false, value: "processed" });
});

test("duplicate receipt does not run downstream work", async () => {
  const tx = transactionReturning(0);
  let workCalls = 0;
  const result = await runWithWebhookReceipt(tx, identity, async () => {
    workCalls += 1;
  });
  assert.equal(workCalls, 0);
  assert.deepEqual(result, { duplicateWebhook: true });
});

test("downstream errors propagate so the enclosing transaction can roll back", async () => {
  const tx = transactionReturning(1);
  await assert.rejects(
    runWithWebhookReceipt(tx, identity, async () => {
      throw new Error("queue write failed");
    }),
    /queue write failed/,
  );
});

test("webhook ID validation rejects missing and whitespace-only values", () => {
  assert.equal(requireShopifyWebhookId({ webhookId: null }), null);
  assert.equal(requireShopifyWebhookId({ webhookId: "   " }), null);
  assert.equal(requireShopifyWebhookId({ webhookId: " webhook-1 " }), "webhook-1");
});
