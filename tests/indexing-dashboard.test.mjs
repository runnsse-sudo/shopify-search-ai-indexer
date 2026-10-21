import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptDiagnostic, webhookDiagnostic, parseQueueFilters, parseAttemptBefore, queueHref,
  readIndexingSummary, readIndexingDashboard, readIndexingDetail,
} from "../app/services/indexing-dashboard.ts";

const now = new Date("2026-10-21T12:00:00.000Z");
function queue(overrides = {}) {
  return { id: "queue-1", shopId: "shop-1", shopifyProductGid: "gid://shopify/Product/12", provider: "INDEXNOW", action: "INDEX",
    status: "PENDING", retryCount: 1, maxRetries: 5, nextAttemptAt: now, claimedAt: null, completedAt: null, createdAt: now, updatedAt: now, attempts: [], ...overrides };
}
function attempt(overrides = {}) {
  return { id: "attempt-1", shopId: "shop-1", queueItemId: "queue-1", provider: "INDEXNOW", attemptNumber: 1, successful: true,
    responseCode: 200, startedAt: now, completedAt: now, ...overrides };
}
function fixture({ items = [queue()], attempts = [], webhooks = [], shop = { id: "shop-1" } } = {}) {
  const calls = [];
  const record = (name, result) => async (args) => { calls.push({ name, args }); return result; };
  const client = {
    shop: { findUnique: record("shop", shop) },
    indexQueueItem: {
      groupBy: record("queue-summary", [{ provider: "INDEXNOW", status: "PENDING", _count: { _all: 5 } }, { provider: "INTERNAL", status: "FAILED", _count: { _all: 2 } }]),
      findMany: record("queue-list", items), findFirst: record("queue-detail", items[0] ?? null),
    },
    indexAttempt: { findMany: record("attempt-list", attempts) },
    webhookReceipt: { groupBy: record("webhook-summary", [{ status: "PENDING", _count: { _all: 3 } }, { status: "RETRY", _count: { _all: 4 } }, { status: "COMPLETED", _count: { _all: 8 } }]), findMany: record("webhook-list", webhooks) },
    shopProviderConfig: { findUnique: record("provider-metadata", { indexNowEnabled: true, indexNowOwnershipVerifiedAt: now }) },
  };
  return { client, calls };
}
const defaults = () => parseQueueFilters(new URLSearchParams());

test("filters default to all shop jobs and links encode exact allowlisted filters", () => {
  assert.deepEqual(defaults(), { status: null, provider: null, product: "", cursor: null });
  const f = parseQueueFilters(new URLSearchParams({ status: "FAILED", provider: "INDEXNOW", product: "12" }));
  assert.equal(queueHref(f), "/app/indexing?status=FAILED&provider=INDEXNOW&product=12");
  assert.equal(parseQueueFilters(new URLSearchParams({ product: "gid://shopify/Product/12" })).product, "gid://shopify/Product/12");
});
for (const [key, value] of [
  ["status", "deleted"], ["provider", "__proto__"], ["product", "../secrets"], ["product", "12?key=secret"], ["product", "0"],
  ["product", "gid://shopify/Order/12"], ["cursor", "{}"], ["cursor", "2026-02-30T00:00:00.000Z~q"],
  ["cursor", "2026-10-21T12:00:00.000Z~../q"], ["cursor", "2026-10-21T12:00:00.000Z~"],
]) test(`reject invalid ${key} input ${value}`, () => assert.throws(() => parseQueueFilters(new URLSearchParams({ [key]: value })), /INVALID_QUEUE_FILTER/));
for (const key of ["status", "provider", "product", "cursor"]) test(`reject repeated ${key}`, () => assert.throws(() => parseQueueFilters(new URLSearchParams(`${key}=&${key}=`)), /INVALID_QUEUE_FILTER/));

test("attempt page positions are positive bounded integers", () => {
  assert.equal(parseAttemptBefore(new URLSearchParams()), null);
  assert.equal(parseAttemptBefore(new URLSearchParams("before=21")), 21);
  for (const value of ["", "0", "-1", "1.1", "Infinity", "2147483648", "01"]) assert.throws(() => parseAttemptBefore(new URLSearchParams({ before: value })));
  assert.throws(() => parseAttemptBefore(new URLSearchParams("before=2&before=3")));
});

test("summary uses three scoped aggregates/metadata reads without loading rows or credential fields", async () => {
  const { client, calls } = fixture();
  const result = await readIndexingSummary(client, "shop-1");
  assert.equal(result.counts.PENDING, 5); assert.equal(result.counts.FAILED, 2);
  assert.equal(result.webhooks.waiting, 7); assert.equal(result.webhooks.processing, 0);
  assert.equal(result.providers.find((p) => p.provider === "INTERNAL").failed, 2);
  assert.equal(calls.length, 3);
  for (const { args } of calls) assert.equal(args.where.shopId, "shop-1");
  assert.deepEqual(calls.find((c) => c.name === "provider-metadata").args.select, { indexNowEnabled: true, indexNowOwnershipVerifiedAt: true });
});
test("missing provider metadata reports unconfigured, without inventing execution readiness", async () => {
  const { client } = fixture(); client.shopProviderConfig.findUnique = async () => null;
  const r = await readIndexingSummary(client, "shop-1");
  assert.deepEqual(r.indexNow, { configured: false, enabled: false, ownershipVerifiedAt: null });
});
test("no shop means no downstream reads or implicitly created records", async () => {
  const { client, calls } = fixture({ shop: null });
  const r = await readIndexingDashboard(client, "missing.myshopify.com", defaults(), now);
  assert.equal(r.summary, null); assert.deepEqual(r.items, []); assert.equal(calls.length, 1);
});
test("list has deterministic keyset paging, scoped filters, a25-row cap and one latest attempt per job", async () => {
  const rows = Array.from({ length: 26 }, (_, i) => queue({ id: `q${26-i}` }));
  const { client, calls } = fixture({ items: rows });
  const filters = parseQueueFilters(new URLSearchParams({ status: "FAILED", provider: "INDEXNOW", product: "12", cursor: `${now.toISOString()}~queue-9` }));
  const r = await readIndexingDashboard(client, "shop.myshopify.com", filters, now);
  assert.equal(r.items.length, 25); assert.equal(r.nextCursor, `${now.toISOString()}~q2`);
  const { args } = calls.find((c) => c.name === "queue-list");
  assert.equal(args.where.shopId, "shop-1"); assert.equal(args.where.provider, "INDEXNOW"); assert.equal(args.where.status, "FAILED");
  assert.equal(args.where.shopifyProductGid, "gid://shopify/Product/12"); assert.equal(args.take, 26); assert.equal(args.skip, undefined);
  assert.deepEqual(args.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(args.where.OR, [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: "queue-9" } }]);
  assert.equal(args.select.attempts.take, 1); assert.deepEqual(args.select.attempts.where, { shopId: "shop-1" });
});
test("empty final page has no next cursor", async () => {
  const { client } = fixture({ items: [] });
  const r = await readIndexingDashboard(client, "shop.myshopify.com", defaults(), now);
  assert.deepEqual(r.items, []); assert.equal(r.nextCursor, null);
});
test("stored error/body/url and arbitrary mock fields never enter browser projection or DB select", async () => {
  const secret = "SYNTHETIC_DO_NOT_EXPORT";
  const { client, calls } = fixture({ items: [queue({ url: secret, reason: secret, lastError: secret, extra: secret, attempts: [attempt({ error: secret, responseBody: secret })] })] });
  const r = await readIndexingDashboard(client, "shop.myshopify.com", defaults(), now);
  assert.equal(JSON.stringify(r).includes(secret), false);
  const select = calls.find((c) => c.name === "queue-list").args.select;
  for (const field of ["url", "lastError", "reason"]) assert.equal(select[field], undefined);
  for (const field of ["error", "responseBody"]) assert.equal(select.attempts.select[field], undefined);
});
test("cross-shop queue or attempt data fails closed", async () => {
  for (const item of [queue({ shopId: "other" }), queue({ attempts: [attempt({ shopId: "other" })] }), queue({ attempts: [attempt({ queueItemId: "other" })] })]) {
    const { client } = fixture({ items: [item] });
    await assert.rejects(readIndexingDashboard(client, "shop.myshopify.com", defaults(), now), /INDEXING_SCOPE_MISMATCH/);
  }
});
test("pending schedule respects time and exhausted budget without authorizing retries", async () => {
  const { client } = fixture({ items: [queue({ id: "due" }), queue({ id: "later", nextAttemptAt: new Date(now.getTime()+1000) }), queue({ id: "exhausted", retryCount: 5 })] });
  const r = await readIndexingDashboard(client, "shop.myshopify.com", defaults(), now);
  assert.deepEqual(r.items.map((x) => x.schedule), ["Waiting for a permitted worker", "Scheduled for later", "Retry budget exhausted; review required"]);
});
test("COMPLETED is not a claim of search engine indexing", async () => {
  for (const provider of ["INTERNAL", "INDEXNOW"]) {
    const { client } = fixture({ items: [queue({ status: "COMPLETED", provider })] });
    const r = await readIndexingDashboard(client, "shop.myshopify.com", defaults(), now);
    assert.match(r.items[0].outcome, /not proven|unverified/); assert.equal(r.items[0].schedule, null);
  }
});
test("detail loads only owned queue and bounded descending attempt history", async () => {
  const attempts = Array.from({ length: 21 }, (_, i) => attempt({ id: `a${30-i}`, attemptNumber: 30-i }));
  const { client, calls } = fixture({ attempts });
  const r = await readIndexingDetail(client, "shop.myshopify.com", "queue-1", 31, now);
  assert.equal(r.attempts.length, 20); assert.equal(r.nextBefore, 11);
  assert.deepEqual(calls.find((c) => c.name === "queue-detail").args.where, { id: "queue-1", shopId: "shop-1" });
  const args = calls.find((c) => c.name === "attempt-list").args;
  assert.deepEqual(args.where, { shopId: "shop-1", queueItemId: "queue-1", attemptNumber: { lt: 31 } });
  assert.equal(args.take, 21); assert.equal(args.select.responseBody, undefined); assert.equal(args.select.error, undefined);
});
test("detail missing or foreign queue does not read attempts", async () => {
  const { client, calls } = fixture({ items: [] });
  assert.equal(await readIndexingDetail(client, "shop.myshopify.com", "queue-1", null, now), null);
  assert.equal(calls.some((c) => c.name === "attempt-list"), false);
  assert.equal(await readIndexingDetail(client, "shop.myshopify.com", "../foreign", null, now), null);
});
test("detail never exports stored provider or error payloads", async () => {
  const { client } = fixture({ attempts: [attempt({ error: "HIDDEN", responseBody: "HIDDEN" })] });
  const r = await readIndexingDetail(client, "shop.myshopify.com", "queue-1", null, now);
  assert.equal(JSON.stringify(r).includes("HIDDEN"), false); assert.equal(r.nextBefore, null);
});
test("provider mismatch and contradictory HTTP outcomes produce review guidance", async () => {
  const { client } = fixture({ items: [queue({ provider: "INTERNAL", attempts: [attempt()] })] });
  const r = await readIndexingDashboard(client, "shop.myshopify.com", defaults(), now);
  assert.match(r.items[0].latestAttempt.diagnostic, /does not match/);
  assert.match(attemptDiagnostic(attempt({ successful: false, responseCode: 200 })), /disagree/);
  assert.match(attemptDiagnostic(attempt({ successful: false, responseCode: 202 })), /disagree/);
});
test("unfinished webhook preview is scoped, capped and sanitizes unknown error classes", async () => {
  const events = Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, shopId: "shop-1", topic: "UNSAFE_SYNTHETIC", shopifyProductGid: null,
    status: "FAILED", attemptCount: 8, nextAttemptAt: now, receivedAt: now, lastErrorClass: "UNSAFE_SYNTHETIC", claimToken: "UNSAFE_SYNTHETIC" }));
  const { client, calls } = fixture({ webhooks: events });
  const r = await readIndexingDashboard(client, "shop.myshopify.com", defaults(), now);
  assert.equal(r.webhooks.length, 10); assert.equal(r.moreWebhooks, true); assert.equal(JSON.stringify(r).includes("UNSAFE_SYNTHETIC"), false);
  const args = calls.find((c) => c.name === "webhook-list").args;
  assert.equal(args.take, 11); assert.equal(args.where.shopId, "shop-1"); assert.deepEqual(args.where.status.in, ["PENDING", "RETRY", "PROCESSING", "FAILED"]);
  assert.equal(args.select.claimToken, undefined);
});
test("foreign webhook data fails closed", async () => {
  const { client } = fixture({ webhooks: [{ shopId: "foreign" }] });
  await assert.rejects(readIndexingDashboard(client, "shop.myshopify.com", defaults(), now), /INDEXING_SCOPE_MISMATCH/);
});
test("webhook diagnostics distinguish auth, rate limits and exhausted retries without raw strings", () => {
  assert.match(webhookDiagnostic("ADMIN_UNAVAILABLE"), /authorization/);
  assert.match(webhookDiagnostic("THROTTLED"), /rate limit/);
  assert.match(webhookDiagnostic("ATTEMPTS_EXHAUSTED"), /budget is exhausted/);
  assert.equal(typeof webhookDiagnostic("__proto__"), "string");
  assert.match(webhookDiagnostic(null), /does not prove/);
});
test("keyset traversal covers same-time jobs exactly once and excludes later inserts", async () => {
  const rows = Array.from({ length: 53 }, (_, i) => queue({ id: `q${String(i).padStart(3, "0")}` }));
  rows.push(queue({ id: "foreign", shopId: "foreign" }));
  const { client } = fixture();
  client.indexQueueItem.findMany = async ({ where, take }) => rows.filter((r) => r.shopId === where.shopId && (!where.OR || r.createdAt < where.OR[0].createdAt.lt || (+r.createdAt === +where.OR[1].createdAt && r.id < where.OR[1].id.lt)))
    .sort((a,b) => +b.createdAt - +a.createdAt || b.id.localeCompare(a.id)).slice(0, take);
  const seen = []; let cursor = null;
  do {
    const f = parseQueueFilters(new URLSearchParams(cursor ? { cursor } : {}));
    const page = await readIndexingDashboard(client, "shop.myshopify.com", f, now);
    seen.push(...page.items.map((r) => r.id)); cursor = page.nextCursor;
    rows.push(queue({ id: "newer", createdAt: new Date(now.getTime()+1000) }));
  } while (cursor);
  assert.equal(seen.length, 53); assert.equal(new Set(seen).size, 53); assert.equal(seen.includes("newer"), false); assert.equal(seen.includes("foreign"), false);
});
for (const [overrides, text] of [
  [{ responseCode: 200 }, /accepted.*inclusion is unverified/], [{ responseCode: 202 }, /validation.*inclusion is unverified/],
  [{ successful: false, responseCode: 403 }, /access was rejected/], [{ successful: false, responseCode: 401 }, /access was rejected/],
  [{ successful: false, responseCode: 429 }, /rate limit/], [{ successful: false, responseCode: 503 }, /temporary server error/],
  [{ successful: false, responseCode: 400 }, /rejected the request/], [{ successful: false, responseCode: null }, /not successful/],
  [{ completedAt: null }, /no recorded completion/], [{ provider: "INTERNAL" }, /Internal preparation/],
  [{ responseCode: null }, /success needs review/], [{ provider: "GOOGLE" }, /success needs review/],
]) test(`safe diagnostic ${JSON.stringify(overrides)}`, () => assert.match(attemptDiagnostic(attempt(overrides)), text));
