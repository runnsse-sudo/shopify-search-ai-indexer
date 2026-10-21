import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkbenchCommand, manualRequestId, parseProductFilters, parseWorkbenchCommand, productEligibility, readProducts, readWorkbenchCommand, workbenchOwner } from "../app/services/product-workbench.ts";

const now = new Date("2026-10-21T12:00:00.000Z");
const owner = workbenchOwner("owned.myshopify.com", "42");
const nonce = "11111111-1111-4111-8111-111111111111";
const product = (id = "p1", more = {}) => ({ id, shopId: "s1", shopifyProductGid: `gid://shopify/Product/${id.slice(1)}`, title: "Product", handle: "product", canonicalUrl: "https://shop.example/products/product", productStatus: "ACTIVE", indexabilityState: "INDEXABLE", published: true, deletedAt: null, lastIndexedAt: null, createdAt: now, updatedAt: now, queueItems: [], ...more });
const command = (ids = ["p1"]) => parseWorkbenchCommand(new URLSearchParams([["intent", "enqueue"], ["requestKey", nonce], ...ids.map((id) => ["product", `${id}~${now.toISOString()}`])]));
function fixture(products = [product()]) {
  const queues = []; const calls = []; let cancelCount = 1;
  const record = (name, fn) => async (args) => { calls.push({ name, args }); return fn(args); };
  const client = {
    shop: { findUnique: record("shop", () => ({ id: "s1", primaryDomain: "shop.example" })) },
    productIndexState: { findMany: record("products", () => products) },
    indexQueueItem: {
      findMany: record("queues", ({ where }) => queues.filter((q) => where.OR[0].id.in.includes(q.id) || ["PENDING", "PROCESSING"].includes(q.status))),
      createMany: record("create", ({ data }) => { const newRows = data.filter((d) => !queues.some((q) => q.id === d.id || (q.dedupeKey && q.dedupeKey === d.dedupeKey))); queues.push(...newRows); return { count: newRows.length }; }),
      updateMany: record("cancel", () => ({ count: cancelCount })),
    },
  };
  return { client, queues, calls, setCancelCount: (count) => { cancelCount = count; } };
}
const writeNames = (f) => f.calls.filter((c) => ["create", "cancel"].includes(c.name));

test("selection deduplicates identical versions and caps raw selections at20", () => {
  assert.equal(command(["p1", "p1"]).products.length, 1);
  assert.equal(command(Array.from({ length: 20 }, (_, i) => `p${i}`)).products.length, 20);
  assert.throws(() => command(Array(21).fill("p1")));
  assert.throws(() => command([]));
});
for (const extra of [["provider", "INDEXNOW"], ["shopId", "foreign"], ["owner", "other"], ["url", "https://evil.example"], ["intent", "enqueue"], ["requestKey", nonce]]) {
  test(`reject client-controlled ${extra[0]}`, () => {
    const p = new URLSearchParams([["intent", "enqueue"], ["requestKey", nonce], ["product", `p1~${now.toISOString()}`], extra]);
    assert.throws(() => parseWorkbenchCommand(p));
  });
}
for (const value of ["../p~2026-10-21T12:00:00.000Z", "p1~2026-02-30T12:00:00.000Z", "p1~bad", "p1~2026-10-21T12:00:00.000Z~extra"]) {
  test(`invalid snapshot ${value}`, () => assert.throws(() => parseWorkbenchCommand(new URLSearchParams({ intent: "enqueue", requestKey: nonce, product: value }))));
}
test("conflicting duplicate versions and invalid nonce fail", () => {
  const p = new URLSearchParams({ intent: "enqueue", requestKey: nonce, product: `p1~${now.toISOString()}` });
  p.append("product", "p1~2026-10-21T12:00:01.000Z"); assert.throws(() => parseWorkbenchCommand(p));
  p.set("requestKey", "not-a-uuid"); assert.throws(() => parseWorkbenchCommand(p));
});
test("bounded same-origin POST rejects missing/cross origin, multipart and oversize streams", async () => {
  const request = (body = "intent=invalid", headers = {}, method = "POST") => new Request("https://app.example/app/products", { method, headers: { origin: "https://app.example", "content-type": "application/x-www-form-urlencoded", ...headers }, ...(method === "GET" ? {} : { body }) });
  await assert.rejects(readWorkbenchCommand(request("x", { origin: "https://foreign.example" })), (e) => e.status === 403);
  await assert.rejects(readWorkbenchCommand(request("x", { origin: "" })), (e) => e.status === 403);
  await assert.rejects(readWorkbenchCommand(request("x", { "content-type": "multipart/form-data" })), (e) => e.status === 415);
  await assert.rejects(readWorkbenchCommand(request("x".repeat(16_385))), (e) => e.status === 413);
  await assert.rejects(readWorkbenchCommand(request("", {}, "GET")), (e) => e.status === 405);
  const body = new URLSearchParams({ intent: "enqueue", requestKey: nonce, product: `p1~${now.toISOString()}` });
  assert.equal((await readWorkbenchCommand(request(body))).intent, "enqueue");
});
for (const override of [{ deletedAt: now }, { productStatus: "DRAFT" }, { published: null }, { published: false }, { indexabilityState: "UNKNOWN_PUBLICATION" }, { canonicalUrl: "https://evil.example/products/p" }, { canonicalUrl: "http://shop.example/products/p" }, { canonicalUrl: "https://shop.example/products/p?token=bad" }, { canonicalUrl: "https://user@shop.example/products/p" }, { canonicalUrl: "https://shop.example:8443/products/p" }, { canonicalUrl: "https://shop.example/cart" }]) {
  test(`ineligible ${JSON.stringify(override)}`, () => assert.equal(productEligibility(product("p1", override), "shop.example"), false));
}
test("eligibility requires explicit primary domain, never infers shop or candidate URL", () => {
  assert.equal(productEligibility(product(), "https://shop.example"), true);
  for (const primary of [null, "", "http://shop.example", "https://shop.example?bad", "https://shop.example/subpath"]) assert.equal(productEligibility(product(), primary), false);
});
test("enqueue inserts <=20 INTERNAL INDEX rows without editing any existing row", async () => {
  const f = fixture(Array.from({ length: 20 }, (_, i) => product(`p${i}`)));
  assert.deepEqual(await applyWorkbenchCommand(f.client, "owned.myshopify.com", owner, command(Array.from({ length: 20 }, (_, i) => `p${i}`)), now), { created: 20, skipped: 0, cancelled: 0 });
  assert.equal(writeNames(f).length, 1);
  const rows = writeNames(f)[0].args.data;
  for (const row of rows) { assert.equal(row.shopId, "s1"); assert.equal(row.provider, "INTERNAL"); assert.equal(row.status, "PENDING"); assert.equal(row.action, "INDEX"); assert.match(row.reason, /^manual-index\/v1:[a-f0-9]{64}$/); assert.match(row.dedupeKey, /^s1\|gid:\/\/shopify\/Product\//); }
});
test("replaying same request after completion or cancellation never requeues it", async () => {
  const f = fixture(); await applyWorkbenchCommand(f.client, "owned.myshopify.com", owner, command(), now);
  for (const status of ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED", "FAILED"]) {
    f.queues[0].status = status; f.queues[0].dedupeKey = null;
    assert.equal((await applyWorkbenchCommand(f.client, "owned.myshopify.com", owner, command(), now)).created, 0);
  }
  assert.equal(f.queues.length, 1); assert.equal(writeNames(f).length, 1);
});
test("existing pending/processing provider and manifest rows are preserved byte for byte", async () => {
  for (const provider of ["INTERNAL", "INDEXNOW"]) for (const status of ["PENDING", "PROCESSING"]) {
    const f = fixture(); f.queues.push({ id: "protected_manifest", shopifyProductGid: product().shopifyProductGid, provider, status, reason: "manifest-bound", retryCount: 3, lastError: "PRIVATE" });
    const before = JSON.stringify(f.queues);
    assert.equal((await applyWorkbenchCommand(f.client, "owned.myshopify.com", owner, command())).created, 0);
    assert.equal(JSON.stringify(f.queues), before); assert.equal(writeNames(f).length, 0);
  }
});
for (const products of [[], [product("p1", { shopId: "foreign" })], [product("p1", { updatedAt: new Date(now.getTime() + 1) })], [product("p1", { published: false })]]) {
  test(`stale/cross-shop/ineligible selection is atomic: ${JSON.stringify(products)}`, async () => {
    const f = fixture(products); await assert.rejects(applyWorkbenchCommand(f.client, "owned.myshopify.com", owner, command()), (e) => e.status === 409); assert.equal(writeNames(f).length, 0);
  });
}
test("one invalid product prevents all inserts in a mixed selection", async () => {
  const f = fixture([product(), product("p2", { published: false })]);
  await assert.rejects(applyWorkbenchCommand(f.client, "owned.myshopify.com", owner, command(["p1", "p2"]))); assert.equal(writeNames(f).length, 0);
});
test("cancel uses owner, shop, fresh version and never-attempted PENDING CAS guards", async () => {
  const f = fixture(); const queueId = manualRequestId("s1", owner, nonce, "p1");
  const cmd = parseWorkbenchCommand(new URLSearchParams({ intent: "cancel", queueId, updatedAt: now.toISOString() }));
  assert.equal((await applyWorkbenchCommand(f.client, "owned.myshopify.com", owner, cmd, now)).cancelled, 1);
  const { where, data } = writeNames(f)[0].args;
  assert.equal(where.shopId, "s1"); assert.equal(where.provider, "INTERNAL"); assert.equal(where.action, "INDEX"); assert.equal(where.status, "PENDING"); assert.equal(where.reason, `manual-index/v1:${owner}`);
  assert.equal(where.retryCount, 0); assert.equal(where.claimedAt, null); assert.deepEqual(where.attempts, { none: {} }); assert.equal(where.updatedAt, cmd.updatedAt);
  assert.deepEqual(data, { status: "CANCELLED", completedAt: now, dedupeKey: null });
  f.setCancelCount(0); await assert.rejects(applyWorkbenchCommand(f.client, "owned.myshopify.com", owner, cmd), (e) => e.status === 409);
});
test("cancel rejects arbitrary queue IDs, provider rows and repeated fields", () => {
  for (const queueId of ["protected_manifest", "manual_123", "../secrets"]) assert.throws(() => parseWorkbenchCommand(new URLSearchParams({ intent: "cancel", queueId, updatedAt: now.toISOString() })));
});
test("session ownership is stable and separated by authenticated shop/session", () => {
  assert.equal(workbenchOwner("owned.myshopify.com", "42"), owner);
  assert.notEqual(workbenchOwner("foreign.myshopify.com", "42"), owner);
  assert.notEqual(workbenchOwner("owned.myshopify.com", "43"), owner);
  assert.throws(() => workbenchOwner("shop", ""));
});
test("product queries are bounded, shop-scoped and project no stored errors/bodies or hashes", async () => {
  const f = fixture(Array.from({ length: 26 }, (_, i) => product(`p${i}`, { contentHash: "PRIVATE", candidateUrl: "PRIVATE" })));
  const result = await readProducts(f.client, "owned.myshopify.com", owner, parseProductFilters(new URLSearchParams({ q: "Product", state: "INDEXABLE", cursor: `${now.toISOString()}~p99` })));
  const query = f.calls.find((c) => c.name === "products").args;
  assert.equal(query.where.shopId, "s1"); assert.equal(query.take, 26); assert.equal(query.select.queueItems.take, 1); assert.equal(query.select.queueItems.where.shopId, "s1");
  assert.equal(result.items.length, 25); assert.ok(result.nextCursor); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|canonicalUrl|contentHash|reason|responseBody/);
});
test("detail rejects unknown IDs and scopes recent history and safe attempt diagnostics", async () => {
  const q = { id: "manual_" + "a".repeat(64), shopId: "s1", shopifyProductGid: product().shopifyProductGid, provider: "INTERNAL", action: "INDEX", status: "PENDING", reason: `manual-index/v1:${owner}`, retryCount: 0, claimedAt: null, updatedAt: now, attempts: [] };
  const f = fixture([product("p1", { queueItems: [q] })]);
  const r = await readProducts(f.client, "owned.myshopify.com", owner, parseProductFilters(new URLSearchParams()), "p1");
  assert.equal(r.items[0].jobs[0].cancellable, true); assert.equal(f.calls.find((c) => c.name === "products").args.select.queueItems.take, 10);
  q.reason = "protected";
  assert.equal((await readProducts(f.client, "owned.myshopify.com", owner, parseProductFilters(new URLSearchParams()), "p1")).items[0].jobs[0].cancellable, false);
  await assert.rejects(readProducts(f.client, "owned.myshopify.com", owner, parseProductFilters(new URLSearchParams()), "../foreign"), (e) => e.status === 404);
});
test("filter validation bounds search, disallows duplicate filters and checks stable cursor", () => {
  for (const query of ["state=FOREIGN", "q=" + "x".repeat(101), "q=a&q=b", "cursor=bad", "q=%00"]) assert.throws(() => parseProductFilters(new URLSearchParams(query)));
  assert.equal(parseProductFilters(new URLSearchParams("state=NOT_PUBLISHED")).state, "NOT_PUBLISHED");
});
