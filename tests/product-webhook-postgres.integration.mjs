/* eslint-env node, es2020 */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

const featureMigration = "20261010170000_add_durable_product_webhooks";
const migrationHash = "fbb08358f863f056b12597f1f74b9f73cada586cba912ea83e6f3a62f4b5024c";
const lockTimeoutMs = 750;
const processTimeoutMs = 45000;
const treeKillGraceMs = 1500;
const legacyCount = 1000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// This runs before even importing Prisma or any application module. No ambient target.
function guardedUrl() {
  assert.equal(process.env.PRODUCT_WEBHOOK_POSTGRES_INTEGRATION, "1", "INTEGRATION_OPT_IN_REQUIRED");
  const raw = process.env.DATABASE_URL;
  assert.ok(raw, "DISPOSABLE_TARGET_REQUIRED");
  assert.ok(!/run\.app|googleapis|cloudsql|runn-search-ai-indexer|production/i.test(raw), "UNSAFE_TARGET");
  let url;
  try { url = new URL(raw); } catch { throw new Error("INVALID_DISPOSABLE_TARGET"); }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "INVALID_PROTOCOL");
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "NONLOCAL_TARGET");
  assert.equal(url.pathname, "/webhook_ci", "INVALID_DATABASE");
  assert.ok(!url.port || url.port === "5432", "INVALID_PORT");
  assert.equal(url.hash, "", "INVALID_FRAGMENT");
  // Disallow socket/host/options overrides disguised as query parameters.
  assert.ok([...url.searchParams].every(([key, value]) => key === "schema" && value === "public"), "UNSAFE_CONNECTION_OPTIONS");
  url.hostname = "127.0.0.1"; // localhost cannot be redirected by host DNS configuration.
  url.port = "5432";
  url.search = "";
  return url;
}

function barrier() {
  let resolvePromise;
  const promise = new Promise((done) => { resolvePromise = done; });
  return { promise, release: resolvePromise };
}

async function resolvePrismaCli() {
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("prisma/package.json");
    const metadata = JSON.parse(await readFile(packagePath, "utf8"));
    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.prisma;
    assert.equal(typeof bin, "string");
    const packageRoot = await realpath(dirname(packagePath));
    const entry = await realpath(resolve(packageRoot, bin));
    const within = relative(packageRoot, entry);
    assert.ok(within && !isAbsolute(within) && !within.startsWith(".."));
    assert.match(entry, /\.[cm]?js$/);
    assert.ok((await stat(entry)).isFile());
    return entry;
  } catch {
    throw Object.assign(new Error("PRISMA_CLI_RESOLUTION_FAILED"), { code: "PRISMA_CLI_RESOLUTION_FAILED" });
  }
}

// Kept independent of DB setup so TEMP-only probes can exercise this exact code.
function runCliProcess(entry, args, env, timeoutMs = processTimeoutMs, graceMs = treeKillGraceMs) {
  return new Promise((done, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: root, env, shell: false, detached: !windows, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", settled = false, timedOut = false, timer, killTimer, helper;
    const discardStdio = (target) => {
      for (const stream of [target?.stdin, target?.stdout, target?.stderr]) {
        if (stream) { stream.on("error", () => {}); stream.destroy(); }
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      discardStdio(child);
      if (error) reject(error); else done(result);
    };
    const signalGroup = (signal) => {
      if (!Number.isInteger(child.pid) || child.pid <= 0) return;
      try { process.kill(-child.pid, signal); } catch { /* ESRCH: group already gone. */ }
    };
    const append = (data) => { output = (output + data.toString()).slice(-65536); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.stdout.on("error", () => {}); child.stderr.on("error", () => {});
    child.on("error", () => {
      if (!timedOut) finish(Object.assign(new Error("PRISMA_CLI_START_FAILED"), { code: "PRISMA_CLI_START_FAILED" }));
    });
    child.once("close", (code) => {
      if (!timedOut) finish(null, { code, output, timedOut: false });
    });
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true; // From here only the hard deadline owns settlement.
      // Install the independent deadline BEFORE any termination operation.
      killTimer = setTimeout(() => {
        if (!windows) signalGroup("SIGKILL");
        if (helper) {
          try { helper.kill("SIGKILL"); } catch { /* Deadline still settles. */ }
          discardStdio(helper); helper.unref();
        }
        try { child.kill("SIGKILL"); } catch { /* Deadline still settles. */ }
        discardStdio(child); child.unref(); // Only the timeout path detaches handles.
        finish(Object.assign(new Error("PRISMA_CLI_TIMEOUT"), { code: "PRISMA_CLI_TIMEOUT" }));
      }, graceMs);
      if (windows && Number.isInteger(child.pid) && child.pid > 0) {
        try {
          const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
          helper = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
            shell: false, windowsHide: true, stdio: "ignore",
          });
          helper.on("error", () => {}); // The grace deadline also bounds this helper.
        } catch { /* Still reject on the independent deadline. */ }
      } else if (!windows) signalGroup("SIGTERM");
      discardStdio(child); // Descendant-held pipes cannot delay promise settlement.
    }, timeoutMs);
  });
}

// Fixed diagnostic vocabulary only; never serialize a rejected error or identity.
function createDiagnostics() {
  const stages = new Set(["SETUP", "MIGRATION_FRESH", "MIGRATION_UPGRADE", "OLD_INSERT", "MIGRATION_LOCK", "DUPLICATE", "LEASE_SETUP", "LEASE", "CLAIM", "STALE_OWNER", "PRODUCT_FENCE", "RETRY_ROLLBACK", "F02_A", "F02_B", "MANIFEST_DRAIN", "CLEANUP"]);
  const checks = new Set(["NONE", "FANOUT_REJECTED_ZERO", "DUP_ACCEPTED_COUNT", "DUP_DUPLICATE_COUNT", "DUP_RECEIPT_COUNT", "DUP_SHOP_COUNT", "LEASE_WINNER_COUNT", "LEASE_PERSISTED_TOKEN_MATCH", "CLAIM_FIRST_PRESENT", "CLAIM_FIRST_EXHAUSTED_FALSE", "CLAIM_FIRST_ATTEMPT_COUNT", "CLAIM_FIRST_STATUS_PROCESSING", "CLAIM_FIRST_TOKEN_PRESENT", "CLAIM_FIRST_TOKEN_MATCH", "CLAIM_FIRST_CLAIMED_AT_MATCH", "CLAIM_SECOND_NULL", "CLAIM_SECOND_ATTEMPT_UNCHANGED", "CLAIM_SECOND_STATUS_PROCESSING", "CLAIM_SECOND_TOKEN_MATCH", "CLAIM_SECOND_CLAIMED_AT_UNCHANGED", "CLEANUP_OPERATION", "CLEANUP_TEMP_PARENT", "CLEANUP_TEMP_NAME"]);
  const codes = new Set(["P2034", "P2002", "P2024", "P2028", "P1001", "P1002", "P1008", "P1017", "ERR_ASSERTION", "PRISMA_CLI_TIMEOUT", "PRISMA_CLI_START_FAILED", "PRISMA_CLI_RESOLUTION_FAILED"]);
  const statuses = new Set(["PENDING", "PROCESSING", "RETRY", "COMPLETED", "FAILED", "CANCELLED"]);
  let currentStage = "SETUP", currentCheck = "NONE", originalContext, cleanupContext;
  const safeCode = (error) => {
    try { const code = error?.code; return codes.has(code) ? code : "OTHER"; }
    catch { return "OTHER"; }
  };
  const snapshot = (error) => Object.freeze({ stage: currentStage, check: currentCheck, code: safeCode(error) });
  return {
    stage(stage) {
      if (!stages.has(stage)) throw new Error("INVALID_DIAGNOSTIC_STAGE");
      currentStage = stage; currentCheck = "NONE";
    },
    check(check) {
      if (!checks.has(check)) throw new Error("INVALID_DIAGNOSTIC_CHECK");
      currentCheck = check;
    },
    safeCode,
    safeStatus: (status) => statuses.has(status) ? status : "OTHER",
    safeCount: (count) => Number.isSafeInteger(count) && count >= 0 ? count : 0,
    captureOriginal(error) { originalContext ??= snapshot(error); },
    captureCleanup(error) { cleanupContext ??= snapshot(error); },
    failureLine(error) {
      const context = originalContext ?? cleanupContext ?? snapshot(error);
      return "PRODUCT_WEBHOOK_POSTGRES_INTEGRATION=FAIL; STAGE=" + context.stage + "; CHECK=" + context.check + "; CODE=" + context.code;
    },
    fanout(stage, results) {
      if (!["DUPLICATE", "LEASE"].includes(stage)) throw new Error("INVALID_DIAGNOSTIC_STAGE");
      const rejected = results.filter((result) => result.status === "rejected");
      const histogram = new Map();
      for (const result of rejected) {
        const code = safeCode(result.reason);
        histogram.set(code, (histogram.get(code) ?? 0) + 1);
      }
      const codes = [...histogram].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([code, count]) => code + ":" + count).join(",") || "NONE";
      console.log("CONCURRENCY_STAGE=" + stage + "; ATTEMPTED=" + results.length + "; FULFILLED=" + (results.length - rejected.length) + "; REJECTED=" + rejected.length + "; REJECTED_CODES=" + codes);
    },
  };
}

const diagnostics = createDiagnostics();

async function main() {
  const base = guardedUrl();
  console.log("DATABASE_GUARD=PASS; HOST=127.0.0.1; DATABASE=webhook_ci");
  if (process.argv.includes("--guard-only")) return;

  // No real Admin client or provider module is used; unexpected HTTP fails closed.
  const denyNetwork = () => { throw new Error("INTEGRATION_HTTP_FORBIDDEN"); };
  globalThis.fetch = denyNetwork;
  http.request = http.get = https.request = https.get = denyNetwork;
  syncBuiltinESMExports();
  // Application imports omit .ts; load the unchanged TS graph with native stripping.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
        return nextResolve(specifier + ".ts", context);
      }
    },
  });
  const clients = new Set();
  const schemas = [];
  let workspace, admin, appClient, releaseLock, lockTask, restoreLockTimeout;
  let originalFailure, cleanupFailure = false;
  const oldEnvironment = process.env.DATABASE_URL;
  const oldGlobal = globalThis.prismaGlobal;
  assert.equal(oldGlobal, undefined, "PREEXISTING_APPLICATION_CLIENT");
  const { PrismaClient } = await import("@prisma/client");
  const prismaCli = await resolvePrismaCli();
  function schemaUrl(schema) {
    assert.match(schema, /^(public|pw_[a-z0-9_]+)$/);
    const url = new URL(base);
    url.searchParams.set("schema", schema);
    url.searchParams.set("connection_limit", "4");
    url.searchParams.set("connect_timeout", "5");
    url.searchParams.set("pool_timeout", "10");
    return url.href;
  }
  function client(schema) {
    const db = new PrismaClient({ datasources: { db: { url: schemaUrl(schema) } }, log: [] });
    clients.add(db);
    return db;
  }
  async function newSchema(kind) {
    const name = "pw_" + kind + "_" + randomBytes(8).toString("hex");
    assert.match(name, /^pw_[a-z0-9_]+$/);
    schemas.push(name); // finally attempts cleanup even if creation failed.
    await admin.$executeRawUnsafe('CREATE SCHEMA "' + name + '"');
    return { name, db: client(name) };
  }
  function cli(schema, form, args = ["deploy"]) {
    // Run the installed Prisma CLI directly; paths are argv, never shell text.
    const directory = join(workspace, form);
    const env = {
      ...process.env,
      DATABASE_URL: schemaUrl(schema),
      CHECKPOINT_DISABLE: "1",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    };
    return runCliProcess(prismaCli, ["migrate", ...args, "--schema", join(directory, "schema.prisma")], env);
  }
  async function deploy(schema, form) {
    const result = await cli(schema, form);
    assert.equal(result.timedOut, false, "MIGRATION_PROCESS_TIMEOUT");
    assert.equal(result.code, 0, "MIGRATION_DEPLOY_FAILED");
  }
  async function migrated(db, expected) {
    const rows = await db.$queryRawUnsafe('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name');
    assert.deepEqual(rows.map((row) => row.migration_name), expected);
  }
  async function columns(db, schema, table) {
    return db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name=${table}`;
  }
  async function durableSchema(db, schema, migrations) {
    await migrated(db, migrations);
    const receipt = (await columns(db, schema, "WebhookReceipt")).map((row) => row.column_name);
    for (const field of ["status", "receivedAt", "attemptCount", "nextAttemptAt", "claimedAt", "claimToken", "completedAt", "lastErrorClass"]) assert.ok(receipt.includes(field), "MISSING_RECEIPT_COLUMN");
    assert.ok((await columns(db, schema, "Shop")).some((row) => row.column_name === "productWebhookNextAttemptAt"));
    const enums = await db.$queryRaw`SELECT e.enumlabel FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=${schema} AND t.typname='ProductWebhookStatus' ORDER BY e.enumsortorder`;
    assert.deepEqual(enums.map((row) => row.enumlabel), ["PENDING", "PROCESSING", "RETRY", "COMPLETED", "FAILED", "CANCELLED"]);
    const indexes = await db.$queryRaw`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=${schema} AND tablename='WebhookReceipt'`;
    for (const name of ["WebhookReceipt_status_nextAttemptAt_receivedAt_idx", "WebhookReceipt_status_claimedAt_idx", "WebhookReceipt_shopId_webhookId_key"]) assert.ok(indexes.some((row) => row.indexname === name), "MISSING_RECEIPT_INDEX");
    assert.match(indexes.find((row) => row.indexname === "WebhookReceipt_shopId_webhookId_key").indexdef, /UNIQUE.*\("shopId", "webhookId"\)/);
  }
  async function seedLegacy(db) {
    await db.$executeRawUnsafe(`INSERT INTO "Shop" (id,domain,"updatedAt") VALUES ('legacy_shop','legacy.example',CURRENT_TIMESTAMP)`);
    await db.$executeRawUnsafe(`INSERT INTO "WebhookReceipt" (id,"shopId","webhookId",topic,"processedAt") SELECT 'legacy_'||i,'legacy_shop','legacy_delivery_'||i,'products/update',TIMESTAMP '2026-01-01 00:00:00' + i * INTERVAL '1 millisecond' FROM generate_series(1,${legacyCount}) i`);
    return db.$queryRawUnsafe('SELECT id,"webhookId","processedAt" FROM "WebhookReceipt" ORDER BY id');
  }
  async function backfill(db, before) {
    const after = await db.webhookReceipt.findMany({ where: { shopId: "legacy_shop" }, orderBy: { id: "asc" } });
    assert.equal(before.length, legacyCount);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      const a = after[i], b = before[i];
      assert.equal(a.id, b.id); assert.equal(a.webhookId, b.webhookId);
      for (const field of ["processedAt", "receivedAt", "completedAt"]) assert.equal(+a[field], +b.processedAt);
      assert.equal(a.status, "COMPLETED"); assert.equal(a.attemptCount, 0);
      for (const field of ["claimToken", "claimedAt", "lastErrorClass"]) assert.equal(a[field], null);
    }
  }
  try {
    admin = client("public");
    const version = await admin.$queryRawUnsafe("SHOW server_version");
    assert.match(version[0].server_version, /^17\./, "POSTGRES_MAJOR_NOT_17");
    console.log("POSTGRES_VERSION=" + version[0].server_version);
    const migrationRoot = join(root, "prisma", "migrations");
    const directories = (await readdir(migrationRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const baseline = directories.filter((name) => name !== featureMigration);
    assert.equal(baseline.length, 4); assert.equal(directories.length, 5);
    assert.equal(directories.at(-1), featureMigration);
    const sql = await readFile(join(migrationRoot, featureMigration, "migration.sql"));
    assert.equal(createHash("sha256").update(sql).digest("hex"), migrationHash, "MIGRATION_BYTES_CHANGED");
    workspace = await mkdtemp(join(tmpdir(), "pw_migrations_"));
    assert.ok(!resolve(workspace).startsWith(root), "TEMP_WORKSPACE_INSIDE_REPOSITORY");
    for (const [form, names] of [["baseline", baseline], ["full", directories]]) {
      const directory = join(workspace, form);
      await mkdir(join(directory, "migrations"), { recursive: true });
      await cp(join(root, "prisma", "schema.prisma"), join(directory, "schema.prisma"));
      await cp(join(migrationRoot, "migration_lock.toml"), join(directory, "migrations", "migration_lock.toml"));
      for (const name of names) await cp(join(migrationRoot, name), join(directory, "migrations", name), { recursive: true });
    }

    diagnostics.stage("MIGRATION_FRESH");
    const full = await newSchema("full");
    await deploy(full.name, "full");
    await durableSchema(full.db, full.name, directories);
    console.log("MIGRATION_FRESH_FULL=PASS; MIGRATIONS=5");
    diagnostics.stage("MIGRATION_UPGRADE");
    const upgrade = await newSchema("upgrade");
    await deploy(upgrade.name, "baseline"); await migrated(upgrade.db, baseline);
    const legacy = await seedLegacy(upgrade.db);
    await deploy(upgrade.name, "full");
    await durableSchema(upgrade.db, upgrade.name, directories); await backfill(upgrade.db, legacy);
    console.log("MIGRATION_UPGRADE=PASS; LEGACY_ROWS_BEFORE=1000; LEGACY_ROWS_AFTER=1000; LEGACY_ROWS_PRESERVED=YES");
    diagnostics.stage("OLD_INSERT");
    const { acquireWebhookReceiptWithClient } = await import("../app/services/webhook-idempotency.server.ts");
    const oldInput = { shopId: "legacy_shop", webhookId: "old_runtime_delivery", eventId: null, topic: "products/update", shopifyProductGid: "gid://shopify/Product/1", triggeredAt: null };
    const oldInsert = () => upgrade.db.$transaction((tx) => acquireWebhookReceiptWithClient(tx, oldInput));
    assert.equal(await oldInsert(), "ACQUIRED"); assert.equal(await oldInsert(), "DUPLICATE");
    const oldRow = await upgrade.db.webhookReceipt.findUniqueOrThrow({ where: { shopId_webhookId: { shopId: oldInput.shopId, webhookId: oldInput.webhookId } } });
    assert.equal(oldRow.status, "COMPLETED"); assert.ok(oldRow.processedAt && oldRow.receivedAt && oldRow.nextAttemptAt);
    assert.equal(oldRow.attemptCount, 0);
    for (const field of ["claimToken", "claimedAt", "lastErrorClass", "completedAt"]) assert.equal(oldRow[field], null);
    console.log("OLD_RUNTIME_INSERT_CONTRACT=PASS");

    diagnostics.stage("MIGRATION_LOCK");
    const locked = await newSchema("lock");
    await deploy(locked.name, "baseline"); await migrated(locked.db, baseline);
    const lockLegacy = await seedLegacy(locked.db);
    const previous = await admin.$queryRawUnsafe("SELECT setting FROM pg_db_role_setting s JOIN pg_database d ON d.oid=s.setdatabase CROSS JOIN LATERAL unnest(s.setconfig) setting WHERE d.datname=current_database() AND s.setrole=0 AND setting LIKE 'lock_timeout=%'");
    const previousTimeout = previous[0]?.setting.slice("lock_timeout=".length);
    restoreLockTimeout = async () => {
      if (previousTimeout === undefined) await admin.$executeRawUnsafe('ALTER DATABASE "webhook_ci" RESET lock_timeout');
      else {
        assert.match(previousTimeout, /^[0-9.]+(us|ms|s|min|h|d)?$/);
        await admin.$executeRawUnsafe('ALTER DATABASE "webhook_ci" SET lock_timeout = \'' + previousTimeout + "'");
      }
    };
    await admin.$executeRawUnsafe('ALTER DATABASE "webhook_ci" SET lock_timeout = \'' + lockTimeoutMs + "ms'");
    const freshConnection = client(locked.name);
    assert.equal((await freshConnection.$queryRawUnsafe("SHOW lock_timeout"))[0].lock_timeout, "750ms", "NEW_CONNECTION_TIMEOUT_NOT_SET");
    const holder = client(locked.name), acquired = barrier(), release = barrier();
    releaseLock = release.release;
    lockTask = holder.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "WebhookReceipt" IN ACCESS SHARE MODE');
      acquired.release();
      await release.promise;
    }, { maxWait: 5000, timeout: 60000 });
    // Promise.race also surfaces acquisition errors instead of waiting forever on a barrier.
    await Promise.race([acquired.promise, lockTask.then(() => { throw new Error("LOCK_NOT_HELD"); })]);
    // On failure the outer finally releases/reset resources without replacing
    // the assertion that failed. Normal-path cleanup happens before recovery.
    {
      const started = performance.now();
      const blocked = await cli(locked.name, "full");
      assert.equal(blocked.timedOut, false, "LOCK_TEST_PROCESS_TIMEOUT");
      assert.notEqual(blocked.code, 0, "BLOCKED_MIGRATION_SUCCEEDED");
      assert.ok(performance.now() - started < processTimeoutMs, "LOCK_ATTEMPT_UNBOUNDED");
      assert.match(blocked.output, /lock timeout/i, "FAILURE_NOT_LOCK_TIMEOUT");
      const history = await locked.db.$queryRawUnsafe('SELECT finished_at FROM "_prisma_migrations" WHERE migration_name=\'' + featureMigration + "'");
      assert.ok(history.length > 0 && history.every((row) => row.finished_at === null), "FAILED_MIGRATION_MARKED_APPLIED");
      assert.ok(!(await columns(locked.db, locked.name, "WebhookReceipt")).some((row) => row.column_name === "status"), "PARTIAL_RECEIPT_SCHEMA");
      assert.ok(!(await columns(locked.db, locked.name, "Shop")).some((row) => row.column_name === "productWebhookNextAttemptAt"), "PARTIAL_SHOP_SCHEMA");
      const partialEnum = await locked.db.$queryRaw`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=${locked.name} AND t.typname='ProductWebhookStatus'`;
      assert.equal(partialEnum.length, 0, "PARTIAL_ENUM_SCHEMA");
      console.log("LOCKED_MIGRATION_FAILED_SAFELY=YES; PARTIAL_SCHEMA_AFTER_FAILURE=NO");
    }
    releaseLock(); await lockTask; releaseLock = undefined; lockTask = undefined;
    await restoreLockTimeout(); restoreLockTimeout = undefined;
    // Prisma 6 records failed attempts. Resolve only after proving zero partial DDL,
    // never --applied and never silently discard a partially applied migration.
    const resolved = await cli(locked.name, "full", ["resolve", "--rolled-back", featureMigration]);
    assert.equal(resolved.timedOut, false); assert.equal(resolved.code, 0, "FAILED_ATTEMPT_RESOLUTION_FAILED");
    await deploy(locked.name, "full");
    await durableSchema(locked.db, locked.name, directories); await backfill(locked.db, lockLegacy);
    console.log("MIGRATION_AFTER_LOCK_RELEASE=PASS");

    diagnostics.stage("SETUP");
    // Set the schema-specific URL BEFORE importing the real app/db singleton.
    process.env.DATABASE_URL = schemaUrl(full.name);
    const core = await import("../app/services/product-indexing.server.ts");
    appClient = (await import("../app/db.server.ts")).default;
    clients.add(appClient);
    const store = await import("../app/services/product-webhook-store.ts");
    const { productWebhookConfig, WebhookOwnershipLostError } = await import("../app/services/product-webhook-control.ts");
    const { runSerializableTransactionWithRetry } = await import("../app/services/serializable-transaction-retry.server.ts");
    const config = productWebhookConfig({ PRODUCT_WEBHOOK_WORKER_ENABLED: "true" });
    const pools = Array.from({ length: 4 }, () => client(full.name));
    const tx = (db, callback) => runSerializableTransactionWithRetry(() => db.$transaction(callback, { isolationLevel: "Serializable", maxWait: 10000, timeout: 15000 }));
    const at = () => new Date();
    const identity = (tag) => ({ shopDomain: tag + ".example", webhookId: tag, productGid: "gid://shopify/Product/1", topic: "products/update" });
    const fanout = async (stage, count, work) => {
      diagnostics.stage(stage);
      const gate = barrier();
      const pending = Array.from({ length: count }, (_, i) => gate.promise.then(() => work(pools[i % pools.length], i)));
      gate.release();
      const results = await Promise.allSettled(pending);
      diagnostics.fanout(stage, results);
      diagnostics.check("FANOUT_REJECTED_ZERO");
      assert.equal(results.filter((result) => result.status === "rejected").length, 0, "CONCURRENCY_RETRIES_EXHAUSTED");
      return results.map((result) => result.value);
    };
    const intake = await fanout("DUPLICATE", 16, (db) => tx(db, (connection) => store.acceptProductWebhookWithClient(connection, identity("duplicate"), at())));
    console.log("DUP_ACCEPTED=" + intake.filter((value) => value === "ACCEPTED").length + "; DUP_DURABLE=" + intake.filter((value) => value === "DUPLICATE_DURABLE").length);
    diagnostics.check("DUP_ACCEPTED_COUNT");
    assert.equal(intake.filter((value) => value === "ACCEPTED").length, 1);
    diagnostics.check("DUP_DUPLICATE_COUNT");
    assert.equal(intake.filter((value) => value === "DUPLICATE_DURABLE").length, 15);
    diagnostics.check("DUP_RECEIPT_COUNT");
    const receiptCount = await full.db.webhookReceipt.count();
    console.log("DUP_RECEIPTS=" + diagnostics.safeCount(receiptCount));
    assert.equal(receiptCount, 1);
    diagnostics.check("DUP_SHOP_COUNT");
    const shopCount = await full.db.shop.count();
    console.log("DUP_SHOPS=" + diagnostics.safeCount(shopCount));
    assert.equal(shopCount, 1);
    diagnostics.stage("LEASE_SETUP");
    // Pre-existing row isolates the lease CAS from independent initial upsert contention.
    await full.db.providerAutomationLease.upsert({ where: { key: store.PRODUCT_WEBHOOK_LEASE_KEY }, create: { key: store.PRODUCT_WEBHOOK_LEASE_KEY }, update: {} });
    const leaseTime = at();
    const leases = await fanout("LEASE", 8, (db) => store.acquireProductWebhookLeaseWithClient(db, config.claimStaleMs, leaseTime));
    const winners = leases.filter(Boolean);
    console.log("LEASE_RESULT_COUNT=" + leases.length + "; LEASE_WINNERS=" + winners.length);
    diagnostics.check("LEASE_WINNER_COUNT");
    assert.equal(winners.length, 1);
    let lease = winners[0];
    diagnostics.check("LEASE_PERSISTED_TOKEN_MATCH");
    const persistedLease = await full.db.providerAutomationLease.findUniqueOrThrow({ where: { key: store.PRODUCT_WEBHOOK_LEASE_KEY } });
    console.log("LEASE_TOKEN_MATCH=" + (persistedLease.ownerToken === lease.ownerToken));
    assert.equal(persistedLease.ownerToken, lease.ownerToken);
    diagnostics.stage("CLAIM");
    // The production runner awaits each work cycle before the next claim.
    // Both guards use one time so refresh cannot move the takeover boundary.
    const claimTime = at();
    diagnostics.check("CLAIM_FIRST_PRESENT");
    const ownerA = await tx(full.db, (connection) => store.claimProductWebhookWithClient(connection, config, lease, [], claimTime));
    assert.ok(ownerA);
    diagnostics.check("CLAIM_FIRST_EXHAUSTED_FALSE");
    assert.equal(ownerA.exhausted, false);
    const claimedRow = await full.db.webhookReceipt.findUniqueOrThrow({ where: { id: ownerA.id } });
    diagnostics.check("CLAIM_FIRST_ATTEMPT_COUNT");
    assert.equal(claimedRow.attemptCount, 1);
    diagnostics.check("CLAIM_FIRST_STATUS_PROCESSING");
    assert.equal(claimedRow.status, "PROCESSING");
    diagnostics.check("CLAIM_FIRST_TOKEN_PRESENT");
    assert.ok(claimedRow.claimToken !== null);
    diagnostics.check("CLAIM_FIRST_TOKEN_MATCH");
    assert.equal(claimedRow.claimToken, ownerA.claimToken);
    diagnostics.check("CLAIM_FIRST_CLAIMED_AT_MATCH");
    assert.equal(+claimedRow.claimedAt, +ownerA.claimedAt);
    console.log("CLAIM_FIRST_PRESENT=true; CLAIM_FIRST_EXHAUSTED=false; CLAIM_FIRST_ATTEMPT_COUNT=" + diagnostics.safeCount(claimedRow.attemptCount) + "; CLAIM_FIRST_STATUS=" + diagnostics.safeStatus(claimedRow.status) + "; CLAIM_FIRST_TOKEN_PRESENT=true; CLAIM_FIRST_TOKEN_MATCH=true; CLAIM_FIRST_CLAIMED_AT_MATCH=true");

    diagnostics.check("CLAIM_SECOND_NULL");
    const secondClaim = await tx(full.db, (connection) => store.claimProductWebhookWithClient(connection, config, lease, [], claimTime));
    assert.equal(secondClaim, null);
    const afterSecondClaim = await full.db.webhookReceipt.findUniqueOrThrow({ where: { id: ownerA.id } });
    diagnostics.check("CLAIM_SECOND_ATTEMPT_UNCHANGED");
    assert.equal(afterSecondClaim.attemptCount, claimedRow.attemptCount);
    diagnostics.check("CLAIM_SECOND_STATUS_PROCESSING");
    assert.equal(afterSecondClaim.status, "PROCESSING");
    diagnostics.check("CLAIM_SECOND_TOKEN_MATCH");
    assert.equal(afterSecondClaim.claimToken, claimedRow.claimToken);
    diagnostics.check("CLAIM_SECOND_CLAIMED_AT_UNCHANGED");
    assert.equal(+afterSecondClaim.claimedAt, +claimedRow.claimedAt);
    console.log("CLAIM_SECOND_NULL=true; CLAIM_SECOND_ATTEMPT_UNCHANGED=true; CLAIM_SECOND_STATUS=" + diagnostics.safeStatus(afterSecondClaim.status) + "; CLAIM_SECOND_TOKEN_MATCH=true; CLAIM_SECOND_CLAIMED_AT_UNCHANGED=true");
    console.log("DUPLICATE_ACCEPTED_COUNT=1; DUPLICATE_DURABLE_COUNT=15; ERRORS=0; LEASE_RACE_WINNERS=1; CLAIM_WINNERS=1");

    diagnostics.stage("STALE_OWNER");
    const future = new Date(claimTime.getTime() + config.claimStaleMs + 1);
    lease = await store.acquireProductWebhookLeaseWithClient(full.db, config.claimStaleMs, future); assert.ok(lease);
    const ownerB = await tx(full.db, (connection) => store.claimProductWebhookWithClient(connection, config, lease, [], future));
    assert.ok(ownerB && !ownerB.exhausted); assert.equal(ownerB.staleRecovered, true);
    assert.notEqual(ownerA.claimToken, ownerB.claimToken); assert.equal(ownerB.attemptCount, 2);
    for (const operation of [
      (connection) => store.completeProductWebhookWithClient(connection, ownerA, future),
      (connection) => store.failProductWebhookWithClient(connection, ownerA, config, { code: "THROTTLED", retryable: true }, future),
      (connection) => store.failProductWebhookWithClient(connection, ownerA, config, { code: "APPLICATION_ERROR", retryable: false }, future),
    ]) await assert.rejects(tx(full.db, operation), WebhookOwnershipLostError);
    await store.releaseProductWebhookLeaseWithClient(full.db, ownerA.lease);
    assert.equal((await full.db.providerAutomationLease.findUniqueOrThrow({ where: { key: store.PRODUCT_WEBHOOK_LEASE_KEY } })).ownerToken, ownerB.lease.ownerToken);

    const syntheticAdmin = (onDomain) => {
      const calls = { product: 0, domain: 0 };
      return { calls, graphql: async (query) => {
        if (query.includes("ShopPrimaryDomain")) {
          calls.domain++; if (onDomain) await onDomain();
          return Response.json({ data: { shop: { primaryDomain: { host: "fallback.example", url: "https://fallback.example" } } } });
        }
        assert.ok(query.includes("ProductForIndexing"), "UNEXPECTED_ADMIN_QUERY"); calls.product++;
        return Response.json({ data: { product: { id: "gid://shopify/Product/1", legacyResourceId: "1", handle: "sample", title: "Synthetic", descriptionHtml: "", productType: "", vendor: "", tags: [], status: "ACTIVE", onlineStoreUrl: "https://public.example/products/sample", publishedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", seo: { title: null, description: null }, variants: { nodes: [] }, media: { nodes: [] } } } });
      } };
    };
    const processClaim = (claim, adminResponse) => core.processProductDetection({ admin: adminResponse, shopDomain: claim.shop.domain, productGid: claim.shopifyProductGid, eventType: "UPDATED", primaryDomain: claim.shop.primaryDomain, durableClaim: claim });
    diagnostics.stage("PRODUCT_FENCE");
    await full.db.shop.update({ where: { id: ownerA.shopId }, data: { primaryDomain: null } });
    const staleAdmin = syntheticAdmin();
    await assert.rejects(processClaim(ownerA, staleAdmin), WebhookOwnershipLostError);
    for (const model of ["productIndexState", "indexEvent", "indexQueueItem"]) assert.equal(await full.db[model].count(), 0, "STALE_OWNER_COMMITTED_PRODUCT_EFFECT");
    assert.equal((await full.db.shop.findUniqueOrThrow({ where: { id: ownerA.shopId } })).primaryDomain, null);
    await processClaim(ownerB, syntheticAdmin());
    assert.equal((await full.db.webhookReceipt.findUniqueOrThrow({ where: { id: ownerB.id } })).status, "COMPLETED");
    assert.equal(await full.db.productIndexState.count(), 1);
    await store.releaseProductWebhookLeaseWithClient(full.db, ownerB.lease);
    lease = await store.acquireProductWebhookLeaseWithClient(full.db, config.claimStaleMs, at()); assert.ok(lease);
    console.log("STALE_OWNER_FENCING=PASS; PRODUCT_MUTATION_FENCE=PASS; CURRENT_OWNER_COMPLETION=PASS");

    const work = async (tag, primaryDomain) => {
      const input = identity(tag);
      await tx(full.db, (connection) => store.acceptProductWebhookWithClient(connection, input, at()));
      await full.db.shop.update({ where: { domain: input.shopDomain }, data: { primaryDomain } });
      const claim = await tx(full.db, (connection) => store.claimProductWebhookWithClient(connection, config, lease, [], at()));
      assert.ok(claim && !claim.exhausted); assert.equal(claim.shop.domain, input.shopDomain);
      return claim;
    };
    diagnostics.stage("RETRY_ROLLBACK");
    const retryClaim = await work("retry", "retry.example");
    const beforeCooldown = (await full.db.shop.findUniqueOrThrow({ where: { id: retryClaim.shopId } })).productWebhookNextAttemptAt;
    const retryAt = at(); const syntheticRollback = new Error("SYNTHETIC_ROLLBACK");
    await assert.rejects(tx(full.db, async (connection) => {
      await store.failProductWebhookWithClient(connection, retryClaim, config, { code: "THROTTLED", retryable: true }, retryAt);
      throw syntheticRollback;
    }), (error) => error === syntheticRollback);
    const stillOwned = await full.db.webhookReceipt.findUniqueOrThrow({ where: { id: retryClaim.id } });
    assert.equal(stillOwned.status, "PROCESSING"); assert.equal(stillOwned.claimToken, retryClaim.claimToken);
    assert.equal(+stillOwned.claimedAt, +retryClaim.claimedAt);
    assert.equal(+(await full.db.shop.findUniqueOrThrow({ where: { id: retryClaim.shopId } })).productWebhookNextAttemptAt, +beforeCooldown);
    const next = await tx(full.db, (connection) => store.failProductWebhookWithClient(connection, retryClaim, config, { code: "THROTTLED", retryable: true }, retryAt));
    const retried = await full.db.webhookReceipt.findUniqueOrThrow({ where: { id: retryClaim.id } });
    assert.equal(retried.status, "RETRY"); assert.equal(retried.claimToken, null); assert.equal(retried.claimedAt, null);
    assert.ok(retried.nextAttemptAt > retryAt); assert.equal(+retried.nextAttemptAt, +next.nextAttemptAt);
    assert.equal(+(await full.db.shop.findUniqueOrThrow({ where: { id: retryClaim.shopId } })).productWebhookNextAttemptAt, +next.nextAttemptAt);
    console.log("RETRY_COOLDOWN_ROLLBACK=PASS; RETRY_COOLDOWN_ATOMIC_COMMIT=PASS");

    diagnostics.stage("F02_A");
    const raceA = await work("race_a", "claim-a.example");
    await pools[1].shop.update({ where: { id: raceA.shopId }, data: { primaryDomain: "persisted-b.example" } });
    const adminA = syntheticAdmin(); await processClaim(raceA, adminA);
    assert.deepEqual(adminA.calls, { product: 1, domain: 0 });
    assert.equal((await full.db.shop.findUniqueOrThrow({ where: { id: raceA.shopId } })).primaryDomain, "persisted-b.example");
    assert.equal((await full.db.productIndexState.findUniqueOrThrow({ where: { shopId_shopifyProductGid: { shopId: raceA.shopId, shopifyProductGid: raceA.shopifyProductGid } } })).candidateUrl, "https://persisted-b.example/products/sample");
    diagnostics.stage("F02_B");
    const raceB = await work("race_b", null);
    const adminB = syntheticAdmin(() => pools[2].shop.update({ where: { id: raceB.shopId }, data: { primaryDomain: "persisted-b.example" } }));
    await processClaim(raceB, adminB);
    assert.deepEqual(adminB.calls, { product: 1, domain: 1 });
    assert.equal((await full.db.shop.findUniqueOrThrow({ where: { id: raceB.shopId } })).primaryDomain, "persisted-b.example");
    assert.equal((await full.db.productIndexState.findUniqueOrThrow({ where: { shopId_shopifyProductGid: { shopId: raceB.shopId, shopifyProductGid: raceB.shopifyProductGid } } })).candidateUrl, "https://persisted-b.example/products/sample");
    console.log("F02_RACE_A=PASS; F02_RACE_B=PASS; PROVIDER_CALLS=0");

    diagnostics.stage("MANIFEST_DRAIN");
    const contract = await import("../app/services/product-webhook-drain-contract.ts");
    const { runManifestBoundProductWebhookDrain } = await import("../app/services/product-webhook-runner.ts");
    const { prepareProductWebhookDrainAuth } = await import("../app/services/product-webhook-drain-auth.server.ts");
    await store.releaseProductWebhookLeaseWithClient(full.db, lease);
    const drainShop = await full.db.shop.create({ data: { id: "integration-drain-shop", domain: "integration-drain.myshopify.com", primaryDomain: "store.example", productWebhookNextAttemptAt: new Date(0) } });
    await full.db.productIndexState.createMany({ data: Array.from({ length: 17 }, (_, i) => ({ id: `integration-product-${i}`, shopId: drainShop.id, shopifyProductGid: `gid://shopify/Product/${5000 + i}`, contentHash: "a".repeat(64), indexabilityState: "INDEXABLE", shopifyUpdatedAt: new Date(0), canonicalUrl: "https://store.example/products/sample" })) });
    await full.db.webhookReceipt.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ id: `integration-receipt-${String(i).padStart(2, "0")}`, shopId: drainShop.id, webhookId: `integration-delivery-${i}`, shopifyProductGid: `gid://shopify/Product/${5000 + i % 17}`, topic: "products/update", status: "PENDING", attemptCount: 0, processedAt: null, receivedAt: new Date(0), nextAttemptAt: new Date(0) })) });
    const manifestRows = await full.db.webhookReceipt.findMany({ where: { shopId: drainShop.id }, orderBy: { id: "asc" } });
    const manifest = manifestRows.map(row => Object.fromEntries(["id", "shopId", "webhookId", "shopifyProductGid", "topic"].map(k => [k, row[k]])));
    const rawManifest = contract.canonicalDrainJson(manifest), manifestHash = contract.drainHash(rawManifest);
    const rawEffects = contract.canonicalDrainJson({ manifestSha256: manifestHash, domain: drainShop.domain, primaryDomain: "store.example", products: (await full.db.productIndexState.findMany({ where: { shopId: drainShop.id } })).map(contract.drainProduct), queues: [] });
    const drainConfig = productWebhookConfig({ PRODUCT_WEBHOOK_WORKER_ENABLED: "true", PRODUCT_WEBHOOK_DRAIN_MODE: "manifest-once-v1", PRODUCT_WEBHOOK_DRAIN_MANIFEST_B64: Buffer.from(rawManifest).toString("base64"), PRODUCT_WEBHOOK_DRAIN_MANIFEST_SHA256: manifestHash, PRODUCT_WEBHOOK_DRAIN_EFFECTS_B64: Buffer.from(rawEffects).toString("base64"), PRODUCT_WEBHOOK_DRAIN_EFFECTS_SHA256: contract.drainHash(rawEffects) });
    const spec = drainConfig.drain;
    assert.ok(spec);
    await full.db.webhookReceipt.create({ data: { id: "earlier-outside-manifest", shopId: drainShop.id, webhookId: "outside-delivery", shopifyProductGid: manifest[0].shopifyProductGid, topic: "products/update", status: "PENDING", receivedAt: new Date(0), nextAttemptAt: new Date(0) } });
    const drainLease = await store.acquireProductWebhookLeaseWithClient(full.db, config.claimStaleMs, at()); assert.ok(drainLease);
    const race = await Promise.allSettled([full.db, pools[0]].map(db => tx(db, connection => store.claimManifestProductWebhookWithClient(connection, spec, spec.manifest[0], drainLease, at(), drainShop.domain))));
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1, "DRAIN_CAS_WINNERS");
    const owned = race.find(r => r.status === "fulfilled").value;
    assert.equal(owned.id, spec.manifest[0].id); assert.equal(owned.attemptCount, 1);
    assert.equal((await full.db.webhookReceipt.findUniqueOrThrow({ where: { id: "earlier-outside-manifest" } })).attemptCount, 0);
    const effectState = contract.createDrainEffectState(spec);
    const drainAdmin = { graphql: async (_query, options) => Response.json({ data: { product: { id: options.variables.id, legacyResourceId: "1", handle: "sample", title: "Synthetic", descriptionHtml: "", productType: "", vendor: "", tags: [], status: "ACTIVE", onlineStoreUrl: "https://store.example/products/sample", publishedAt: "2026-01-01T00:00:00Z", updatedAt: at().toISOString(), seo: { title: null, description: null }, variants: { nodes: [] }, media: { nodes: [] } } } }) };
    const originalTransaction = appClient.$transaction.bind(appClient);
    const rollback = new Error("SYNTHETIC_DRAIN_ROLLBACK");
    try {
      appClient.$transaction = (callback, options) => originalTransaction(async connection => { await callback(connection); throw rollback; }, options);
      await assert.rejects(core.processProductDetection({ admin: drainAdmin, shopDomain: drainShop.domain, productGid: owned.shopifyProductGid, eventType: "UPDATED", durableClaim: owned, drainEffects: effectState }), error => error === rollback);
    } finally { appClient.$transaction = originalTransaction; }
    assert.equal(await full.db.indexEvent.count({ where: { shopId: drainShop.id } }), 0);
    assert.equal(await full.db.indexQueueItem.count({ where: { shopId: drainShop.id } }), 0);
    assert.equal((await full.db.webhookReceipt.findUniqueOrThrow({ where: { id: owned.id } })).status, "PROCESSING");
    assert.equal(effectState.created.size, 0);
    assert.equal((await full.db.productIndexState.findUniqueOrThrow({ where: { id: "integration-product-0" } })).contentHash, "a".repeat(64));
    const { enqueueProductWithClient } = await import("../app/services/index-queue-client.ts");
    let externalInserted = false;
    await assert.rejects(tx(full.db, async connection => {
      const p = await connection.productIndexState.findUniqueOrThrow({ where: { id: "integration-product-0" } });
      const fence = await contract.beginDrainTransaction(effectState, connection, p, drainShop.id, manifest[0].shopifyProductGid, drainShop.primaryDomain);
      if (!externalInserted) {
        await pools[1].indexQueueItem.create({ data: { id: "unapproved-slot", shopId: drainShop.id, shopifyProductGid: manifest[0].shopifyProductGid, provider: "INTERNAL", action: "INDEX", status: "PENDING", reason: "UNAPPROVED", dedupeKey: `${drainShop.id}|${manifest[0].shopifyProductGid}|INTERNAL|INDEX` } });
        externalInserted = true;
      }
      await enqueueProductWithClient(connection, { shopId: drainShop.id, shopifyProductGid: manifest[0].shopifyProductGid, url: "https://store.example/products/sample", reason: "CONTENT_CHANGED" }, fence);
    }));
    const untouchedSlot = await full.db.indexQueueItem.findUniqueOrThrow({ where: { id: "unapproved-slot" } });
    assert.equal(untouchedSlot.reason, "UNAPPROVED"); assert.equal(untouchedSlot.status, "PENDING");
    assert.equal(effectState.created.size, 0);
    await full.db.indexQueueItem.delete({ where: { id: "unapproved-slot" } });
    // Reset only synthetic isolated test data, never production/replay behavior.
    await full.db.webhookReceipt.update({ where: { id: owned.id }, data: { status: "PENDING", attemptCount: 0, claimToken: null, claimedAt: null } });
    await store.releaseProductWebhookLeaseWithClient(full.db, drainLease);
    let authReads = 0, loads = 0, acquisitions = 0;
    let expires = new Date(0);
    const authMetadata = () => ({ domain: drainShop.domain, primaryDomain: drainShop.primaryDomain, sessions: [{ id: `offline_${drainShop.domain}`, shop: drainShop.domain, isOnline: false, scope: "read_products", expires }] });
    const drainDeps = {
      preflight: () => tx(full.db, connection => store.preflightProductWebhookDrainWithClient(connection, spec, at())),
      auth: () => prepareProductWebhookDrainAuth({ spec, requiredScopes: "read_products", now: at, readMetadata: async () => authMetadata(), loadSession: async () => { loads++; return { ...authMetadata().sessions[0], accessToken: "SYNTHETIC_ONLY", isScopeChanged: () => false }; }, fetch: async (_url, options) => { authReads++; const body = JSON.parse(options.body); return body.query.includes("ShopPrimaryDomain") ? Response.json({ data: { shop: { primaryDomain: { host: "store.example" } } } }) : drainAdmin.graphql(body.query, { variables: body.variables }); } }),
      acquireLease: () => { acquisitions++; return store.acquireProductWebhookLeaseWithClient(full.db, config.claimStaleMs, at()); }, releaseLease: l => store.releaseProductWebhookLeaseWithClient(full.db, l),
      claim: (member, l, now, expectedDomain) => tx(full.db, connection => store.claimManifestProductWebhookWithClient(connection, spec, member, l, now, expectedDomain)),
      guard: (work, now) => tx(full.db, connection => store.guardProductWebhookClaimWithClient(connection, work, now)),
      process: (work, adminResponse, effects) => core.processProductDetection({ admin: adminResponse, shopDomain: work.shop.domain, productGid: work.shopifyProductGid, eventType: "UPDATED", metadata: { webhookId: work.webhookId }, durableClaim: work, drainEffects: effects }),
      fail: (work, error, now) => tx(full.db, connection => store.failProductWebhookWithClient(connection, work, drainConfig, error, now)),
      log: () => {}, now: at, delay: async () => {}, shouldStop: () => false,
    };
    await assert.rejects(runManifestBoundProductWebhookDrain(drainConfig, drainDeps));
    assert.equal(loads, 0); assert.equal(authReads, 0); assert.equal(acquisitions, 0);
    expires = new Date(Date.now() + 3600000);
    await runManifestBoundProductWebhookDrain(drainConfig, drainDeps);
    assert.equal(loads, 1); assert.equal(authReads, 21); assert.equal(acquisitions, 1);
    assert.equal(await full.db.webhookReceipt.count({ where: { id: { in: manifest.map(r => r.id) }, status: "COMPLETED", attemptCount: 1, claimToken: null, claimedAt: null } }), 20);
    assert.equal(await full.db.indexEvent.count({ where: { shopId: drainShop.id } }), 20);
    assert.equal(await full.db.productIndexState.count({ where: { shopId: drainShop.id } }), 17);
    assert.equal(await full.db.indexQueueItem.count({ where: { shopId: drainShop.id } }), 17);
    assert.equal((await full.db.webhookReceipt.findUniqueOrThrow({ where: { id: "earlier-outside-manifest" } })).attemptCount, 0);
    await assert.rejects(runManifestBoundProductWebhookDrain(drainConfig, drainDeps));
    console.log("MANIFEST_DRAIN_POSTGRES=PASS; RECEIPTS=20; PRODUCTS=17; EVENTS=20; OUTSIDE_CLAIMS=0; AUTH_REFRESH=0; CAS_WINNERS=1; QUEUE_ROLLBACK=PASS; CONCURRENT_SLOT_FENCE=PASS");
  } catch (error) {
    diagnostics.captureOriginal(error);
    originalFailure = error;
    throw error;
  } finally {
    diagnostics.stage("CLEANUP");
    diagnostics.check("CLEANUP_OPERATION");
    const cleanupErrors = [];
    const clean = async (callback) => {
      diagnostics.check("CLEANUP_OPERATION");
      try { await callback(); }
      catch (error) { diagnostics.captureCleanup(error); cleanupErrors.push(true); }
    };
    if (releaseLock) releaseLock();
    if (lockTask) await clean(() => lockTask);
    if (restoreLockTimeout) await clean(restoreLockTimeout);
    for (const db of clients) if (db !== admin) await clean(() => db.$disconnect());
    if (admin) {
      await clean(() => admin.$executeRawUnsafe("SET statement_timeout = '5s'"));
      for (const name of schemas.reverse()) await clean(() => admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + name + '" CASCADE'));
      await clean(() => admin.$disconnect());
    }
    if (workspace) await clean(async () => {
      const target = resolve(workspace);
      diagnostics.check("CLEANUP_TEMP_PARENT");
      assert.equal(dirname(target), resolve(tmpdir()), "UNSAFE_TEMP_CLEANUP_PARENT");
      diagnostics.check("CLEANUP_TEMP_NAME");
      assert.match(basename(target), /^pw_migrations_[a-zA-Z0-9]+$/, "UNSAFE_TEMP_CLEANUP_NAME");
      diagnostics.check("CLEANUP_OPERATION");
      await rm(target, { recursive: true, force: true });
    });
    diagnostics.check("CLEANUP_OPERATION");
    process.env.DATABASE_URL = oldEnvironment;
    if (oldGlobal === undefined) delete globalThis.prismaGlobal;
    else globalThis.prismaGlobal = oldGlobal;
    hooks.deregister();
    if (cleanupErrors.length) {
      console.error("CLEANUP_FAILURE_COUNT=" + cleanupErrors.length);
      if (!originalFailure) cleanupFailure = true;
    }
  }
  if (cleanupFailure) throw new Error("INTEGRATION_CLEANUP_FAILED");
  console.log("PRODUCT_WEBHOOK_POSTGRES_INTEGRATION=PASS");
}

// Never print raw Prisma/CLI errors, assertion values, URLs or credentials.
main().catch((error) => {
  console.error(diagnostics.failureLine(error));
  process.exitCode = 1;
});
