import { setImmediate } from "node:timers";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { robottoCatalogFailure } from "../app/services/llm-visibility/robotto-catalog-diagnostics.ts";
import { CATALOG_SHOPS } from "../app/services/llm-visibility/multishop-catalog-targets.ts";

const targets = CATALOG_SHOPS.map((shop, i) => ({
  shop,
  primaryDomain: `shop${i}.example`,
  fileId: `gid://shopify/GenericFile/${i + 1}`,
  cdnPath: `/s/files/1/0000/000${i}/files/llms-full.txt`,
}));
const fixture = {
  database: `globalThis.__dbLoaded=true; export default { async $disconnect(){globalThis.__disconnected=true;if(globalThis.__disconnectError)throw Object.assign(new Error('private database URL'),{code:'P1001'});} };`,
  shopify: `export const unauthenticated={async admin(shop){if(globalThis.__sessionError)throw new Error('private refresh token');return {admin:{},session:{shop,isOnline:false}};}};`,
  storage: `export function catalogStorage(bucket,shop){return {shop,async withLock(run){globalThis.__locks[shop]=true;const result=await run();delete globalThis.__locks[shop];return result;}};}`,
  publisher: `export function catalogPublisher(target,onPhase){return {async refresh(storage,shop,getAdmin){onPhase('lock');return storage.withLock(async()=>{onPhase('session');await getAdmin();const failure=globalThis.__failures[shop];if(failure){onPhase(failure.phase);throw new Error(failure.code,{cause:failure.cause?new Error(failure.cause):undefined});}return {status:'UNCHANGED',sha256:'a'.repeat(64)};});}};}`,
};
let compiled;
async function worker() {
  if (!compiled)
    compiled = build({
      entryPoints: [
        fileURLToPath(
          new URL("../workers/multishop-catalog-worker.ts", import.meta.url),
        ),
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      plugins: [
        {
          name: "synthetic-runtime-only",
          setup(b) {
            b.onResolve({ filter: /db\.server$/ }, () => ({
              path: "database",
              namespace: "fixture",
            }));
            b.onResolve({ filter: /shopify\.server$/ }, () => ({
              path: "shopify",
              namespace: "fixture",
            }));
            b.onResolve(
              { filter: /multishop-catalog-storage\.server\.ts$/ },
              () => ({ path: "storage", namespace: "fixture" }),
            );
            b.onResolve(
              { filter: /multishop-catalog-publication\.server\.ts$/ },
              () => ({ path: "publisher", namespace: "fixture" }),
            );
            b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
              contents: fixture[a.path],
              loader: "js",
            }));
          },
        },
      ],
    });
  return (await compiled).outputFiles[0].text;
}
async function run(options = {}) {
  const rows = [];
  const context = {
    process: {
      argv: ["node", "synthetic-worker", "--run-enabled-catalogs-once"],
      env: {
        LLM_CATALOG_TARGETS: JSON.stringify(targets),
        LLM_CATALOG_BUCKET: "synthetic-catalog-bucket",
      },
    },
    console: {
      log: (x) => rows.push(JSON.parse(x)),
      error: (x) => rows.push(JSON.parse(x)),
    },
    __failures: options.failures ?? {},
    __locks: {},
    __sessionError: options.sessionError,
    __disconnectError: options.disconnectError,
    fetch() {
      throw new Error("NETWORK_MUST_NOT_RUN");
    },
  };
  if (options.disabled) context.process.argv = ["node", "synthetic-worker"];
  runInNewContext(await worker(), context);
  for (let i = 0; i < 30; i++) await new Promise(setImmediate);
  return { rows, context };
}

test("all multishop internal codes survive only as exact allowlisted constants", async () => {
  for (const path of [
    "multishop-catalog-targets.ts",
    "multishop-catalog-publication.server.ts",
    "multishop-catalog-storage.server.ts",
    "llm-catalog.server.ts",
  ]) {
    const source = await readFile(
      new URL("../app/services/llm-visibility/" + path, import.meta.url),
      "utf8",
    );
    for (const [, code] of source.matchAll(/new Error\("([A-Z_]+)"/g))
      assert.equal(
        robottoCatalogFailure(new Error(code), "catalog").code,
        code,
      );
  }
});

test("diagnostics expose neither provider text nor a disguised/injected cause", () => {
  for (const value of [
    new Error("https://private/?token=secret"),
    new Error("CATALOG_READ_FAILED\nsecret"),
    { message: "STAGING_REJECTED", token: "secret" },
  ]) {
    const result = robottoCatalogFailure(value, "stage");
    assert.equal(result.code, "CATALOG_UNEXPECTED_ERROR");
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
  const good = robottoCatalogFailure(
    new Error("PUBLICATION_UNCONFIRMED", {
      cause: new Error("FILE_UPDATE_REJECTED"),
    }),
    "public_verify",
  );
  assert.equal(good.causeCode, "FILE_UPDATE_REJECTED");
  const bad = robottoCatalogFailure(
    new Error("PUBLICATION_UNCONFIRMED", {
      cause: new Error("FILE_UPDATE_REJECTED private-token"),
    }),
    "public_verify",
  );
  assert.equal(bad.causeCode, undefined);
});

test("actual worker preserves three store-specific codes/phases, locks, failure exit and other stores", async () => {
  const failures = {
    "1cba5a-f6.myshopify.com": {
      phase: "catalog_generate",
      code: "CATALOG_URL_MISMATCH",
    },
    "94d715-94.myshopify.com": {
      phase: "public_verify",
      code: "PUBLICATION_UNCONFIRMED",
      cause: "FILE_UPDATE_REJECTED",
    },
    "game-dungeon-9024.myshopify.com": {
      phase: "catalog_generate",
      code: "CATALOG_EXPORT_LIMIT",
    },
  };
  const { rows, context } = await run({ failures });
  assert.equal(rows.length, 6);
  assert.equal(context.process.exitCode, 1);
  assert.equal(context.__disconnected, true);
  for (const [shop, expected] of Object.entries(failures)) {
    const row = rows.find((x) => x.shop === shop);
    assert.equal(row.status, "FAILED");
    assert.equal(row.code, expected.code);
    assert.equal(row.phase, expected.phase);
    assert.equal(row.reviewRequired, true);
    assert.equal(context.__locks[shop], true);
    if (expected.cause) assert.equal(row.causeCode, expected.cause);
  }
  assert.equal(rows.filter((x) => x.status === "UNCHANGED").length, 3);
  assert.deepEqual(
    Object.keys(context.__locks).sort(),
    Object.keys(failures).sort(),
  );
});

test("unknown session failures retain session phase and locks, without logging credentials", async () => {
  const { rows, context } = await run({ sessionError: true });
  assert.equal(rows.length, 6);
  assert.equal(context.process.exitCode, 1);
  for (const row of rows) {
    assert.equal(row.phase, "session");
    assert.equal(row.code, "CATALOG_UNEXPECTED_ERROR");
    assert.equal(row.status, "FAILED");
  }
  assert.equal(Object.keys(context.__locks).length, 6);
  assert.ok(!JSON.stringify(rows).includes("private"));
});

test("disabled worker performs no database initialization or synthetic publication", async () => {
  const { rows, context } = await run({ disabled: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "CATALOG_WORKER_NOT_ENABLED");
  assert.equal(rows[0].phase, "configuration");
  assert.equal(context.__dbLoaded, undefined);
  assert.equal(context.process.exitCode, 1);
});

test("disconnect errors stay safe and cannot turn an otherwise successful worker into PASS", async () => {
  const { rows, context } = await run({ disconnectError: true });
  assert.equal(context.process.exitCode, 1);
  assert.equal(rows.at(-1).phase, "disconnect");
  assert.equal(rows.at(-1).code, "P1001");
  assert.equal(rows.at(-1).status, "REVIEW_REQUIRED");
  assert.ok(!JSON.stringify(rows).includes("private database"));
});
