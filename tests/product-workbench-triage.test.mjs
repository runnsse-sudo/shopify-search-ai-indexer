import assert from "node:assert/strict";
import test from "node:test";
import { parseProductFilters, productEligibilityReason, readProducts, workbenchOwner } from "../app/services/product-workbench.ts";
import { selectEligibleProducts } from "../app/services/product-workbench.shared.ts";
import { exportProductPage } from "../app/services/product-workbench-export.ts";

const now = new Date("2026-10-28T12:00:00.000Z");
const product = (more = {}) => ({ id: "p1", shopId: "owned", shopifyProductGid: "gid://shopify/Product/1", title: "Product", handle: "one", canonicalUrl: "https://shop.example/products/one", productStatus: "ACTIVE", published: true, indexabilityState: "INDEXABLE", deletedAt: null, createdAt: now, updatedAt: now, lastIndexedAt: null, queueItems: [], ...more });
const exported = (more = {}) => ({ gid: "gid://shopify/Product/1", title: "Product", handle: "one", state: "INDEXABLE", productStatus: "ACTIVE", eligible: true, eligibilityReason: null, lastIndexedAt: now, jobs: [], ...more });

for (const work of ["ACTIVE", "FAILED", "NONE"]) test(`history ${work} is scoped in the database before pagination`, async () => {
  let query;
  const client = { shop: { findUnique: async () => ({ id: "owned", primaryDomain: "shop.example" }) }, productIndexState: { findMany: async (args) => { query = args; return [product()]; } } };
  const result = await readProducts(client, "shop.myshopify.com", workbenchOwner("shop.myshopify.com", "42"), parseProductFilters(new URLSearchParams({ work, q: "One", state: "INDEXABLE", cursor: `${now.toISOString()}~p9` })));
  assert.equal(query.where.shopId, "owned");
  assert.equal(query.where.indexabilityState, "INDEXABLE");
  assert.equal(query.take, 26); assert.ok(query.where.AND); assert.equal(query.where.OR.length, 3);
  assert.deepEqual(query.where.queueItems, work === "NONE" ? { none: { shopId: "owned" } } : { some: { shopId: "owned", status: work === "ACTIVE" ? { in: ["PENDING", "PROCESSING"] } : "FAILED" } });
  assert.equal(query.select.queueItems.take, 1); assert.equal(query.select.queueItems.where.shopId, "owned");
  assert.equal(result.items[0].eligible, true); assert.equal(result.items[0].eligibilityReason, null);
});
for (const query of ["work=FAILED&work=NONE", "work=COMPLETED", "work=failed", "work=%00"]) test(`invalid triage filter rejected: ${query}`, () => assert.throws(() => parseProductFilters(new URLSearchParams(query))));

test("eligibility reasons explain rejection without exposing URL or credentials", () => {
  for (const [more, text] of [[{ deletedAt: now }, /Deletion/], [{ productStatus: "DRAFT" }, /active/], [{ published: null }, /Publication/], [{ indexabilityState: "MISSING_URL" }, /indexable/], [{ canonicalUrl: "https://user:PRIVATE@shop.example/products/one" }, /same-domain/]]) {
    const reason = productEligibilityReason(product(more), "shop.example"); assert.match(reason, text); assert.doesNotMatch(reason, /PRIVATE|https:|user/);
  }
  assert.equal(productEligibilityReason(product(), null), "Verified same-domain product URL is required");
});
test("page selection excludes ineligible products, preserves order and caps at20", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, updatedAt: now, eligible: i !== 1 }));
  const values = selectEligibleProducts(rows);
  assert.equal(values.length, 20); assert.equal(values[0], `p0~${now.toISOString()}`); assert.equal(values[1], `p2~${now.toISOString()}`);
  assert.equal(selectEligibleProducts(rows.map((p) => ({ ...p, eligible: false }))).length, 0);
  assert.deepEqual(selectEligibleProducts([]), []);
});

test("CSV explicitly projects public metadata, quotes delimiters and never exports private fields", () => {
  const csv = exportProductPage([exported({ title: 'Product, "quoted"\nnext', reason: "PRIVATE", canonicalUrl: "PRIVATE", responseBody: "PRIVATE", jobs: [{ provider: "INTERNAL", status: "COMPLETED", diagnostic: "PRIVATE" }] })]);
  assert.match(csv, /"Product, ""quoted"" next"/); assert.match(csv, /"INTERNAL","COMPLETED"/);
  assert.match(csv, /2026-10-28T12:00:00.000Z/); assert.doesNotMatch(csv, /PRIVATE/);
  assert.equal(csv.split("\r\n").length, 3);
});
for (const title of ["=HYPERLINK(1)", "+cmd", "-1", "@SUM(1)", " \t=cmd", "\r\n+cmd", "\u2003=cmd"]) test(`spreadsheet formula neutralized: ${JSON.stringify(title)}`, () => {
  const csv = exportProductPage([exported({ title })]);
  const line = csv.split("\r\n")[1]; assert.match(line, /,"'[^"]*[=+@-]/u);
});
test("CSV bounds rows and cells and labels recorded rather than verified indexing", () => {
  assert.throws(() => exportProductPage(Array.from({ length: 26 }, () => exported())), /EXPORT_PAGE_LIMIT/);
  const csv = exportProductPage([exported({ title: "x".repeat(2000), lastIndexedAt: null })]);
  assert.ok(csv.length < 1500); assert.match(csv, /Last recorded indexing/); assert.doesNotMatch(csv, /Invalid Date/);
  assert.equal(exportProductPage([]).split("\r\n").length, 2);
});
