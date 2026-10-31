import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkbenchCommand, parseWorkbenchCommand, workbenchOwner } from "../app/services/product-workbench.ts";
import { parseOwnedRequestFilters, readOwnedPendingRequests } from "../app/services/owned-requests.ts";
import { exportPendingRequestPage } from "../app/services/product-workbench-export.ts";

const now = new Date("2026-10-31T12:00:00.000Z");
const id = (n = 1) => `manual_${n.toString(16).padStart(64, "0")}`;
const owner = workbenchOwner("shop.myshopify.com", "42");
const params = (...rows) => new URLSearchParams([["intent", "cancelMany"], ...rows.map((q) => ["queue", q])]);
const token = (n) => `${id(n)}~${now.toISOString()}`;
const row = (n = 1, extra = {}) => ({ id: id(n), shopId: "s1", shopifyProductGid: `gid://shopify/Product/${n}`, createdAt: now, updatedAt: now, productIndexState: { id: `p${n}`, shopId: "s1", shopifyProductGid: `gid://shopify/Product/${n}`, title: "Owned product" }, ...extra });

test("bulk cancellation parses1..20 and deduplicates only identical versions", () => {
  const command = parseWorkbenchCommand(params(token(1), token(1), token(2)));
  assert.equal(command.intent, "cancelMany"); assert.deepEqual(command.requests, [{ id: id(1), updatedAt: now }, { id: id(2), updatedAt: now }]);
  assert.equal(parseWorkbenchCommand(params(...Array.from({ length: 20 }, (_, i) => token(i + 1)))).requests.length, 20);
  for (const p of [params(), params(...Array.from({ length: 21 }, () => token(1))), params(token(1), `${id()}~2026-10-31T12:00:01.000Z`)]) assert.throws(() => parseWorkbenchCommand(p));
});
for (const value of ["protected_manifest~" + now.toISOString(), "manual_bad~" + now.toISOString(), token(1) + "~extra", id() + "~2026-02-30T12:00:00.000Z", id() + "~bad"]) {
  test(`bulk cancellation rejects invalid token ${value}`, () => assert.throws(() => parseWorkbenchCommand(params(value))));
}
for (const extra of [["intent", "enqueue"], ["shopId", "foreign"], ["owner", "foreign"], ["provider", "INDEXNOW"], ["updatedAt", now.toISOString()], ["requestKey", "forged"]]) {
  test(`bulk cancellation rejects caller override ${extra[0]}`, () => { const p = params(token(1)); p.append(...extra); assert.throws(() => parseWorkbenchCommand(p)); });
}

test("one conditional bulk update preserves all existing single-cancel ownership/attempt guards", async () => {
  let call;
  const client = { shop: { findUnique: async () => ({ id: "s1" }) }, indexQueueItem: { updateMany: async (args) => { call = args; return { count: 2 }; } } };
  const result = await applyWorkbenchCommand(client, "shop.myshopify.com", owner, parseWorkbenchCommand(params(token(1), token(2))), now);
  assert.deepEqual(result, { created: 0, skipped: 0, cancelled: 2 });
  assert.deepEqual(call.where, { shopId: "s1", reason: `manual-index/v1:${owner}`, provider: "INTERNAL", action: "INDEX", status: "PENDING", retryCount: 0, claimedAt: null, attempts: { none: {} }, OR: [{ id: id(1), updatedAt: now }, { id: id(2), updatedAt: now }] });
  assert.deepEqual(call.data, { status: "CANCELLED", completedAt: now, dedupeKey: null });
});

test("partial match requires409 so enclosing transaction rolls back instead of claiming partial success", async () => {
  const client = { shop: { findUnique: async () => ({ id: "s1" }) }, indexQueueItem: { updateMany: async () => ({ count: 1 }) } };
  await assert.rejects(applyWorkbenchCommand(client, "shop.myshopify.com", owner, parseWorkbenchCommand(params(token(1), token(2))), now), (e) => e.status === 409 && e.message === "STALE_OR_NOT_OWNED");
});
test("direct helper calls cannot exceed cap, repeat IDs or cancel non-manual namespace", async () => {
  let writes = 0;
  const client = { shop: { findUnique: async () => ({ id: "s1" }) }, indexQueueItem: { updateMany: async () => { writes++; return { count: 1 }; } } };
  for (const requests of [[], [{ id: "protected_manifest", updatedAt: now }], [{ id: id(), updatedAt: new Date(NaN) }], [{ id: id(), updatedAt: now }, { id: id(), updatedAt: now }], Array.from({ length: 21 }, (_, i) => ({ id: id(i + 1), updatedAt: now }))]) await assert.rejects(applyWorkbenchCommand(client, "shop.myshopify.com", owner, { intent: "cancelMany", requests }, now));
  assert.equal(writes, 0);
});

test("owned request query scopes owner, shop, linked product and untouched work before pagination", async () => {
  let query;
  const client = { shop: { findUnique: async () => ({ id: "s1" }) }, indexQueueItem: { findMany: async (args) => { query = args; return Array.from({ length: 26 }, (_, i) => row(i + 1)); } } };
  const result = await readOwnedPendingRequests(client, "shop.myshopify.com", owner, parseOwnedRequestFilters(new URLSearchParams({ q: "search", cursor: `${now.toISOString()}~p9` })));
  assert.equal(query.where.shopId, "s1"); assert.equal(query.where.reason, `manual-index/v1:${owner}`);
  assert.equal(query.where.provider, "INTERNAL"); assert.equal(query.where.action, "INDEX"); assert.equal(query.where.status, "PENDING");
  assert.equal(query.where.retryCount, 0); assert.equal(query.where.claimedAt, null); assert.deepEqual(query.where.attempts, { none: {} });
  assert.equal(query.where.productIndexState.is.shopId, "s1"); assert.equal(query.where.productIndexState.is.OR.length, 3);
  assert.equal(query.where.OR.length, 2); assert.equal(query.take, 26); assert.equal(result.items.length, 25);
  assert.equal(result.nextCursor, `${now.toISOString()}~${id(25)}`);
  assert.equal(query.select.reason, undefined); assert.equal(query.select.lastError, undefined);
  assert.doesNotMatch(JSON.stringify(result), /manual-index|reason|responseBody|canonicalUrl/);
});
for (const extra of [{ shopId: "foreign" }, { productIndexState: null }, { productIndexState: { ...row().productIndexState, shopId: "foreign" } }, { productIndexState: { ...row().productIndexState, shopifyProductGid: "gid://shopify/Product/999" } }, { id: "protected_manifest" }]) {
  test(`inconsistent owned query result fails closed ${JSON.stringify(extra)}`, async () => {
    const client = { shop: { findUnique: async () => ({ id: "s1" }) }, indexQueueItem: { findMany: async () => [row(1, extra)] } };
    await assert.rejects(readOwnedPendingRequests(client, "shop.myshopify.com", owner, parseOwnedRequestFilters(new URLSearchParams())), /WORKBENCH_SCOPE_MISMATCH/);
  });
}
for (const q of ["q=a&q=b", "cursor=bad", "owner=foreign", "provider=INDEXNOW", "work=FAILED", "state=INDEXABLE", "format=json", "format=csv&format=csv"]) test(`request filters reject overrides ${q}`, () => assert.throws(() => parseOwnedRequestFilters(new URLSearchParams(q))));
test("no shop and no requests return an empty page without writes", async () => {
  const result = await readOwnedPendingRequests({ shop: { findUnique: async () => null } }, "shop.myshopify.com", owner, parseOwnedRequestFilters(new URLSearchParams()));
  assert.deepEqual(result, { items: [], nextCursor: null });
});
test("pending export reuses formula neutralization and caps without private fields", () => {
  const csv = exportPendingRequestPage([{ ...row(), gid: row().shopifyProductGid, title: "=FORMULA", reason: "PRIVATE", lastError: "PRIVATE" }]);
  assert.match(csv, /"'=FORMULA"/); assert.match(csv, /2026-10-31T12:00:00.000Z/); assert.doesNotMatch(csv, /PRIVATE/);
  assert.throws(() => exportPendingRequestPage(Array.from({ length: 26 }, () => ({ ...row(), gid: row().shopifyProductGid }))), /EXPORT_PAGE_LIMIT/);
});
