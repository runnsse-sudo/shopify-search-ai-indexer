/* eslint-env node */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { applyWorkbenchCommand, manualRequestId, parseWorkbenchCommand, workbenchOwner } from "../app/services/product-workbench.ts";

// This test is prepared for the existing disposable hosted PostgreSQL job only.
// Guard runs before importing Prisma, connecting, creating a schema or spawning a CLI.
export function guardedTarget(env) {
  assert.equal(env.PRODUCT_WORKBENCH_POSTGRES_INTEGRATION, "1", "EXPLICIT_INTEGRATION_OPT_IN_REQUIRED");
  assert.equal(env.GITHUB_ACTIONS, "true", "HOSTED_CI_REQUIRED");
  const url = new URL(env.DATABASE_URL ?? "invalid:");
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "INVALID_PROTOCOL");
  assert.equal(url.hostname, "127.0.0.1", "DISPOSABLE_LOOPBACK_REQUIRED");
  assert.equal(url.pathname, "/webhook_ci", "DISPOSABLE_DATABASE_REQUIRED");
  assert.ok(!url.port || url.port === "5432", "INVALID_PORT");
  assert.equal(url.username, "postgres", "DISPOSABLE_ROLE_REQUIRED");
  assert.equal(url.password, "", "NO_AMBIENT_CREDENTIALS");
  assert.equal(url.hash, "", "INVALID_FRAGMENT");
  assert.ok([...url.searchParams].every(([key, value]) => key === "schema" && value === "public"), "CONNECTION_OVERRIDE_REJECTED");
  return url;
}

async function main() {
  if (process.argv.includes("--guard-self-test")) {
    const safe = { PRODUCT_WORKBENCH_POSTGRES_INTEGRATION: "1", GITHUB_ACTIONS: "true", DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/webhook_ci?schema=public" };
    guardedTarget(safe);
    for (const DATABASE_URL of ["postgresql://postgres@production/webhook_ci", "postgresql://postgres@127.0.0.1:5432/runn_search_ai_indexer", safe.DATABASE_URL + "&host=production", safe.DATABASE_URL.replace("postgres@", "postgres:secret@"), safe.DATABASE_URL.replace("5432", "5433")]) assert.throws(() => guardedTarget({ ...safe, DATABASE_URL }));
    assert.throws(() => guardedTarget({ ...safe, PRODUCT_WORKBENCH_POSTGRES_INTEGRATION: "0" }));
    assert.throws(() => guardedTarget({ ...safe, GITHUB_ACTIONS: "false" }));
    console.log("WORKBENCH_DISPOSABLE_TARGET_GUARDS=PASS; DB_CONNECTIONS=0"); return;
  }
  const target = guardedTarget(process.env);
  const schema = `workbench_${randomBytes(10).toString("hex")}`;
  assert.match(schema, /^workbench_[a-f0-9]{20}$/);
  const { PrismaClient } = await import("@prisma/client");
  const admin = new PrismaClient({ datasources: { db: { url: target.href } } });
  let db;
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    target.searchParams.set("schema", schema);
    const cli = createRequire(import.meta.url).resolve("prisma/build/index.js");
    const setup = spawnSync(process.execPath, [cli, "db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, DATABASE_URL: target.href }, encoding: "utf8", timeout: 45000, windowsHide: true,
    });
    assert.equal(setup.status, 0, "DISPOSABLE_SCHEMA_SETUP_FAILED");
    db = new PrismaClient({ datasources: { db: { url: target.href } } });
    const shop = await db.shop.create({ data: { domain: "workbench-fixture.myshopify.com", primaryDomain: "workbench.example" } });
    const other = await db.shop.create({ data: { domain: "foreign-fixture.myshopify.com", primaryDomain: "foreign.example" } });
    const product = await db.productIndexState.create({ data: { shopId: shop.id, shopifyProductGid: "gid://shopify/Product/1", canonicalUrl: "https://workbench.example/products/one", productStatus: "ACTIVE", published: true, indexabilityState: "INDEXABLE" } });
    const owner = workbenchOwner(shop.domain, "42");
    const nonce = "11111111-1111-4111-8111-111111111111";
    const cmd = parseWorkbenchCommand(new URLSearchParams({ intent: "enqueue", requestKey: nonce, product: `${product.id}~${product.updatedAt.toISOString()}` }));
    const run = (command, domain = shop.domain, owned = owner) => db.$transaction((tx) => applyWorkbenchCommand(tx, domain, owned, command), { isolationLevel: "Serializable", maxWait: 2000, timeout: 5000 });
    const race = await Promise.allSettled([run(cmd), run({ ...cmd, requestKey: "22222222-2222-4222-8222-222222222222" })]);
    assert.ok(race.some((r) => r.status === "fulfilled"));
    assert.equal(await db.indexQueueItem.count({ where: { shopId: shop.id } }), 1, "CONCURRENT_REQUESTS_MUST_DEDUPLICATE");
    let queue = await db.indexQueueItem.findFirstOrThrow({ where: { shopId: shop.id } });
    const cancel = { intent: "cancel", queueId: queue.id, updatedAt: queue.updatedAt };
    for (const [domain, owned] of [[other.domain, owner], [shop.domain, workbenchOwner(shop.domain, "43")]]) await assert.rejects(run(cancel, domain, owned), (e) => e.status === 409);
    const cancelClaim = await Promise.allSettled([run(cancel), db.indexQueueItem.updateMany({ where: { id: queue.id, status: "PENDING" }, data: { status: "PROCESSING", claimedAt: new Date(), dedupeKey: null } })]);
    assert.equal(cancelClaim.filter((r) => r.status === "fulfilled" && (r.value.cancelled === 1 || r.value.count === 1)).length, 1, "CANCEL_CLAIM_SINGLE_WINNER");
    queue = await db.indexQueueItem.findUniqueOrThrow({ where: { id: queue.id } });
    assert.ok(["CANCELLED", "PROCESSING"].includes(queue.status));
    await db.indexQueueItem.update({ where: { id: queue.id }, data: { status: "COMPLETED", claimedAt: null, dedupeKey: null } });
    const originalNonce = queue.id === manualRequestId(shop.id, owner, nonce, product.id) ? nonce : "22222222-2222-4222-8222-222222222222";
    assert.equal((await run({ ...cmd, requestKey: originalNonce })).created, 0, "REPLAY_AFTER_COMPLETION");
    await assert.rejects(run({ ...cmd, products: [{ id: product.id, updatedAt: new Date(0) }] }), (e) => e.status === 409);
    const protectedRow = await db.indexQueueItem.create({ data: { shopId: shop.id, shopifyProductGid: product.shopifyProductGid, provider: "INTERNAL", action: "INDEX", status: "PENDING", reason: "protected-manifest", dedupeKey: `${shop.id}|${product.shopifyProductGid}|INTERNAL|INDEX` } });
    assert.equal((await run({ ...cmd, requestKey: "33333333-3333-4333-8333-333333333333" })).created, 0);
    assert.deepEqual(await db.indexQueueItem.findUniqueOrThrow({ where: { id: protectedRow.id } }), protectedRow, "PROTECTED_ROW_UNCHANGED");
    console.log("PRODUCT_WORKBENCH_POSTGRES=PASS; CONCURRENT_DEDUP=PASS; CANCEL_CLAIM_CAS=PASS; OWNERSHIP=PASS; STALE_SELECTION=PASS; REPLAY=PASS; PROTECTED_ROWS=PASS");
  } finally {
    if (db) await db.$disconnect();
    try { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.$disconnect(); }
  }
}
main().catch(() => { console.error("PRODUCT_WORKBENCH_POSTGRES=FAIL; RAW_ERROR_REDACTED=YES"); process.exitCode = 1; });
