/* eslint-env node */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import {
  checkStoredRedirectTargets,
  loadRedirectHistory,
  recordScheduledRedirectAudit,
} from "../build-tests/redirect-history.mjs";
import { loadDiscoveryQueue, rememberDiscoveryImport, rememberDiscoveryObservations } from "../build-tests/discovery-queue.mjs";
import { checkRedirectDestination } from "../build-tests/redirect-audit-server.mjs";
import { recordCatalogRefresh } from "../app/services/llm-visibility/catalog-history.server.ts";
import { readStoreActionOverview } from "../app/services/store-action-overview.ts";

const ci = process.env.GITHUB_ACTIONS === "true";
assert.equal(process.env.REDIRECT_HISTORY_POSTGRES_INTEGRATION, "1");
const target = ci
  ? "postgresql://postgres@127.0.0.1:5432/webhook_ci"
  : "postgresql://local@127.0.0.1:55483/redirect_history";
assert.equal(process.env.REDIRECT_HISTORY_TEST_DATABASE_URL, target);
const schema = "redirect_history_" + randomBytes(8).toString("hex");
const url = target + "?schema=" + schema;
const admin = new PrismaClient({ datasources: { db: { url: target } } });
const db = new PrismaClient({ datasources: { db: { url } } });
try {
  const cli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  const migration = spawnSync(process.execPath, [cli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url }, timeout: 45_000, encoding: "utf8",
  });
  assert.equal(migration.status, 0, migration.stderr);
  const shop = "redirect-fixture.myshopify.com";
  const otherShop = "other-redirect-fixture.myshopify.com";
  await db.shop.createMany({ data: [{ domain: shop }, { domain: otherShop }] });
  const { id: shopId } = await db.shop.findUniqueOrThrow({ where: { domain: shop } });
  const { id: otherShopId } = await db.shop.findUniqueOrThrow({ where: { domain: otherShop } });
  const first = new Date("2026-11-20T04:00:00Z");
  const checked = new Date("2026-11-20T05:00:00Z");
  await rememberDiscoveryImport(db, shopId, ["/products/old", "/products/old", "/products/pending"], first);
  await rememberDiscoveryImport(db, otherShopId, ["/products/old"], first);
  await rememberDiscoveryObservations(db, shopId, [
    { path: "/products/old", status: "DIRECT_404" },
    { path: "/products/unverified", status: "UNVERIFIED" },
    { path: "/products/working", status: "OTHER_RESPONSE" },
  ], checked);
  await rememberDiscoveryObservations(db, shopId, [{ path: "/products/old", status: "OTHER_RESPONSE" }], first);
  await rememberDiscoveryImport(db, shopId, ["/products/old"], checked);
  let queue = await loadDiscoveryQueue(db, shopId);
  assert.deepEqual(queue.map(({ path, status }) => [path, status]), [
    ["/products/pending", "PENDING"], ["/products/unverified", "UNVERIFIED"], ["/products/old", "DIRECT_404"],
  ]);
  assert.equal(queue[2].firstSeenAt.toISOString(), first.toISOString());
  assert.equal(queue[2].importedAt.toISOString(), checked.toISOString());
  assert.equal((await loadDiscoveryQueue(db, otherShopId))[0].status, "PENDING");
  await rememberDiscoveryObservations(db, shopId, [{ path: "/products/old", status: "OTHER_RESPONSE" }],
    new Date("2026-11-20T06:00:00Z"));
  queue = await loadDiscoveryQueue(db, shopId);
  assert.equal(queue[2].status, "OTHER_RESPONSE");

  const missing = { id: "gid://shopify/UrlRedirect/1", path: "/products/old-one", target: "/products/not-found" };
  const onward = { id: "gid://shopify/UrlRedirect/2", path: "/products/old-two", target: "/products/onward" };
  const diagnostics = {
    verified404Count: 2, checkedLinks: 10, unverifiedLinks: 1,
    skipped: [{ path: "/products/old-two", reason: "NO_SUGGESTED_TARGET", score: null }],
  };
  await recordScheduledRedirectAudit(db, shop, async (save, observe) => {
    observe(diagnostics);
    await save(missing);
    return { status: "COMPLETE" };
  });
  await recordScheduledRedirectAudit(db, shop, async () => ({
    status: "INCOMPLETE_SITEMAP", limitsReached: ["SITEMAP_DOCUMENT_LIMIT"],
  }));
  await assert.rejects(recordScheduledRedirectAudit(db, shop, async (save) => {
    await save(onward);
    throw new Error("private diagnostic must not persist");
  }), /private diagnostic/);
  await recordScheduledRedirectAudit(db, otherShop, async (save) => {
    await save({ ...missing, target: "/products/other-shop" });
    return { status: "COMPLETE" };
  });
  const requested = [];
  await checkStoredRedirectTargets(db, shop, "fixture.example", (domain, path, deadlineAt) =>
    checkRedirectDestination(domain, path, deadlineAt, async (input) => {
      assert.equal(input.allowedHost, "fixture.example");
      assert.equal(input.directStatusOnly, true);
      requested.push(path);
      return { statusCode: path === missing.target ? 404 : 301, error: null };
    }));
  assert.deepEqual(requested.sort(), [missing.target, onward.target].sort());
  let history = await loadRedirectHistory(db, shop);
  assert.equal(history.runs.length, 3);
  assert.deepEqual(history.runs.find((run) => run.status === "COMPLETE").diagnostics, diagnostics);
  assert.equal((await loadRedirectHistory(db, otherShop)).runs[0].diagnostics, null);
  const failed = history.runs.find((run) => run.status === "FAILED");
  assert.equal(failed.stopReason, "AUTOMATIC_REDIRECT_AUDIT_FAILED");
  assert.deepEqual(failed.redirects, [{ shopifyId: onward.id, source: onward.path, target: onward.target }]);
  assert.equal(history.runs.find((run) => run.status === "INCOMPLETE_SITEMAP").stopReason, "SITEMAP_DOCUMENT_LIMIT");
  assert.deepEqual(history.targetIssues.map((row) => row.targetStatus).sort(), ["NOT_FOUND", "REDIRECTS"]);
  assert.equal((await loadRedirectHistory(db, otherShop)).targetIssues.length, 0);
  assert.equal((await loadRedirectHistory(db, otherShop)).runs.length, 1);
  assert.equal(await checkRedirectDestination("fixture.example", "//foreign.example/products/1", Date.now() + 1000,
    async () => assert.fail("External target must not be fetched")), "UNVERIFIED");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await checkStoredRedirectTargets(db, shop, "fixture.example", async () => "OK");
  history = await loadRedirectHistory(db, shop);
  assert.equal(history.targetIssues.length, 0);
  const digest = "a".repeat(64);
  await recordCatalogRefresh(db, shop, async () => ({ status: "UNCHANGED", sha256: digest }), () => "compare_links");
  await recordCatalogRefresh(db, otherShop, async () => ({ status: "PUBLISHED", sha256: "b".repeat(64) }), () => "public_verify");
  const overview = await readStoreActionOverview(db, shop);
  assert.equal(overview.catalog.status, "UNCHANGED");
  assert.equal(overview.redirects.issueCount, 0);
  assert.equal(overview.redirects.summary.status, "FAILED");
  const recorded = await db.catalogRefreshRun.findMany({ where: { shopDomain: shop } });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].sha256, digest);
  await assert.rejects(recordCatalogRefresh(db, shop, async () => { throw new Error("PUBLIC_HASH_NOT_VERIFIED"); }, () => "public_verify"));
  assert.equal((await readStoreActionOverview(db, shop)).catalog.reason, "PUBLIC_HASH_NOT_VERIFIED");
  assert.equal((await readStoreActionOverview(db, otherShop)).catalog.status, "PUBLISHED");
  console.log("Redirect history migration, per-shop isolation, partial writes and destination checks passed");
} finally {
  await db.$disconnect();
  try {
    await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
  } finally {
    await admin.$disconnect();
  }
}
