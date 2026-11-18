import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFile } from "node:fs/promises";
import { readStoreActionOverview } from "../app/services/store-action-overview.ts";
import { recordCatalogRefresh } from "../app/services/llm-visibility/catalog-history.server.ts";

const now = new Date("2026-11-18T12:00:00Z");
const sha = "a".repeat(64);
const run = (values = {}) => ({ status: "UNCHANGED", startedAt: new Date("2026-11-18T03:00:00Z"),
  finishedAt: new Date("2026-11-18T03:01:00Z"), stopReason: null, sha256: sha, _count: { redirects: 0 }, ...values });

function fixture({ catalog = [run(), run()], redirect = [run({ status: "COMPLETE" })], issues = [], success = run() } = {}) {
  const calls = [];
  const read = (name, value) => async (args) => { calls.push({ name, args }); return value; };
  return { calls, db: {
    catalogRefreshRun: { findMany: read("catalog", catalog), findFirst: read("catalog-success", success) },
    redirectAuditRun: { findMany: read("redirect", redirect), findFirst: read("redirect-success", success) },
    redirectAuditCreation: { count: read("issue-count", issues.length), findMany: read("issues", issues) },
  } };
}

test("overview scopes every bounded read to the authenticated shop and compares recorded runs", async () => {
  const { db, calls } = fixture();
  const result = await readStoreActionOverview(db, "one.myshopify.com", now);
  assert.equal(result.catalog.state, "current");
  assert.match(result.catalog.change, /Same file SHA256/);
  assert.match(result.redirects.summary.change, /0 redirects/);
  assert.equal(calls.length, 6);
  for (const { args } of calls) {
    assert.equal(args.where.shopDomain ?? args.where.run.shopDomain, "one.myshopify.com");
    if (args.take) assert.ok(args.take <= 5);
    assert.ok(args.select || "issue-count" === calls.find((c) => c.args === args).name);
    assert.doesNotMatch(JSON.stringify(args), /accessToken|refreshToken|session|ciphertext/);
  }
  assert.deepEqual(calls.find((c) => c.name === "catalog").args.where.status, { not: "NOT_DUE" });
});

test("missing history is unknown and database failures do not hide the independent service", async () => {
  const empty = fixture({ catalog: [], redirect: [], success: null });
  assert.equal((await readStoreActionOverview(empty.db, "one", now)).catalog.state, "unknown");
  const { db } = fixture();
  db.catalogRefreshRun.findMany = async () => { throw new Error("secret database connection"); };
  const result = await readStoreActionOverview(db, "one", now);
  assert.equal(result.catalog.status, "UNAVAILABLE");
  assert.equal(result.redirects.summary.state, "current");
  assert.doesNotMatch(JSON.stringify(result), /secret database/);
});

test("stale successes, failed runs, unfinished runs and future times need explicit attention", async () => {
  const old = run({ finishedAt: new Date(now.getTime() - 37 * 3600000) });
  let result = await readStoreActionOverview(fixture({ success: old }).db, "one", now);
  assert.equal(result.catalog.state, "attention");
  for (const status of ["FAILED", "ROLLED_BACK", "LINK_UPDATE_REQUIRED", "UNRECOGNIZED"]) {
    result = await readStoreActionOverview(fixture({ catalog: [run({ status })] }).db, "one", now);
    assert.equal(result.catalog.state, "attention");
  }
  result = await readStoreActionOverview(fixture({ catalog: [run({ status: "RUNNING", finishedAt: null })] }).db, "one", now);
  assert.equal(result.catalog.state, "attention");
  result = await readStoreActionOverview(fixture({ catalog: [run({ startedAt: new Date(now.getTime() + 1000) })] }).db, "one", now);
  assert.equal(result.catalog.state, "unknown");
});

test("changed hashes, failed target checks and safe stop reasons surface concrete actions", async () => {
  const issue = { shopifyId: "gid://shopify/UrlRedirect/1", source: "/old", target: "/gone", targetStatus: "NOT_FOUND", checkedAt: now };
  const { db } = fixture({ catalog: [run({ sha256: "b".repeat(64) }), run()], issues: [issue] });
  let result = await readStoreActionOverview(db, "one", now);
  assert.match(result.catalog.change, /changed since/);
  assert.equal(result.redirects.summary.state, "attention");
  assert.equal(result.redirects.issueCount, 1);
  db.catalogRefreshRun.findMany = async () => [run({ status: "FAILED", stopReason: "WRITE_FILES_NOT_GRANTED" })];
  result = await readStoreActionOverview(db, "one", now);
  assert.match(result.catalog.message, /file access/);
  db.catalogRefreshRun.findMany = async () => [run({ status: "FAILED", stopReason: "https://secret?token=private" })];
  assert.equal((await readStoreActionOverview(db, "one", now)).catalog.reason, null);
});

function writer({ startFails = false, updateFails = false } = {}) {
  const rows = [];
  return { rows, db: { catalogRefreshRun: {
    create: async ({ data }) => { if (startFails) throw new Error("db unavailable"); rows.push(data); return { id: "run-1" }; },
    update: async ({ data }) => { if (updateFails) throw new Error("write unavailable"); rows.push(data); },
  } } };
}

test("catalog recording preserves outcomes and stores only safe fields", async () => {
  for (const status of ["PUBLISHED", "UNCHANGED", "NOT_DUE", "ROLLED_BACK", "LINK_UPDATE_REQUIRED"]) {
    const { db, rows } = writer();
    const result = { status, sha256: sha, privateUrl: "https://private?token=secret" };
    assert.equal(await recordCatalogRefresh(db, "shop", async () => result, () => "public_verify"), result);
    assert.equal(rows[1].status, status);
    assert.equal(rows[1].sha256, sha);
    assert.doesNotMatch(JSON.stringify(rows), /privateUrl|secret/);
  }
});

test("catalog failure persists safe code and rethrows without retrying publication", async () => {
  const { db, rows } = writer();
  let calls = 0;
  await assert.rejects(recordCatalogRefresh(db, "shop", async () => { calls++; throw new Error("provider secret token"); }, () => "upload"));
  assert.equal(calls, 1);
  assert.equal(rows[1].status, "FAILED");
  assert.equal(rows[1].stopReason, "CATALOG_UNEXPECTED_ERROR");
  assert.doesNotMatch(JSON.stringify(rows), /provider secret/);
});

test("history write failures stop before publication or report unconfirmed history without retry", async () => {
  await assert.rejects(recordCatalogRefresh(writer({ startFails: true }).db, "shop", async () => assert.fail("must not publish"), () => "lock"));
  let calls = 0;
  await assert.rejects(recordCatalogRefresh(writer({ updateFails: true }).db, "shop", async () => { calls++; return { status: "PUBLISHED", sha256: sha }; }, () => "lock"));
  assert.equal(calls, 1);
});

test("rendered overview prioritizes action, escapes paths and exposes only navigation links", async () => {
  await build({ entryPoints: ["app/components/store-action-overview.tsx"], outfile: "build-tests/store-action-overview.mjs",
    bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic" });
  const { StoreActionOverview } = await import("../build-tests/store-action-overview.mjs");
  const { db } = fixture({ issues: [{ shopifyId: "id-1", source: "/<script>secret</script>", target: "/missing", targetStatus: "NOT_FOUND", checkedAt: now }] });
  const overview = await readStoreActionOverview(db, "store.myshopify.com", now);
  const html = renderToStaticMarkup(React.createElement(StoreActionOverview, { overview }));
  assert.ok(html.indexOf('heading="404 &amp; redirect audit"') < html.indexOf('heading="LLM catalog"'));
  assert.match(html, /&lt;script&gt;secret&lt;\/script&gt;/);
  assert.match(html, /Target returned 404/);
  assert.match(html, /href="\/app\/redirect-audit"/);
  assert.doesNotMatch(html, /<button|<form|<script/);
  // Rendered fixture also allows validation of actual Shopify elements without app credentials.
  await writeFile("build-tests/store-action-overview.html", html);
});
