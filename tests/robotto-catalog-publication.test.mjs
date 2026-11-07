import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishRobottoCatalog, publishRobottoCatalogWithBackup, refreshRobottoOnlineStoreCatalog, runPreparedRobottoPilot } from "../app/services/llm-visibility/robotto-catalog-publication.server.ts";

const bytes = value => new TextEncoder().encode(`# www.robotto.se\n${value}\n`);
const backup = bytes("Previous catalog");
const candidate = bytes("New catalog");
const sha = value => createHash("sha256").update(value).digest("hex");
const id = "gid://shopify/GenericFile/62861370655066";
const staged = "https://shopify-staged-uploads.storage.googleapis.com";
const publicUrl = "https://www.robotto.se/cdn/shop/files/llms-full.txt";

test("prepared pilot is shop- and hash-bound and cannot be replayed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "robotto-prepared-pilot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shop = "robotto-7143.myshopify.com";
  let calls = 0;
  const admin = { async graphql() { calls++; throw new Error("SYNTHETIC_PROVIDER_STOP"); } };
  await writeFile(join(directory, "pilot.json"), JSON.stringify({
    previousSha256: sha(backup), candidateSha256: sha(candidate),
  }));
  await writeFile(join(directory, "backup.txt"), backup);
  await writeFile(join(directory, "candidate.txt"), backup);
  await assert.rejects(runPreparedRobottoPilot(directory, "other.myshopify.com", admin), /INVALID_PILOT_TARGET/);
  await assert.rejects(runPreparedRobottoPilot(directory, shop, admin), /PILOT_HASH_MISMATCH/);
  assert.equal(calls, 0);
  await writeFile(join(directory, "candidate.txt"), candidate);
  await assert.rejects(runPreparedRobottoPilot(directory, shop, admin), /SYNTHETIC_PROVIDER_STOP/);
  await assert.rejects(runPreparedRobottoPilot(directory, shop, admin), { code: "EEXIST" });
  assert.equal(calls, 1);
});

function fixture({ failAfterWrite = false, ambiguous = false, drift = false, foreign = false, missingScope = false, initial = backup, fileUrl, mismatch = false, versionDrift = false } = {}) {
  let current = drift ? bytes("External change") : initial;
  let version = 1;
  const downloads = [];
  const writes = [];
  const payloads = new Map();
  let stages = 0;
  const admin = { graphql: async (query, { variables }) => {
    if (query.includes("ReadRobottoCatalog")) {
      assert.equal(variables.id, id);
      return Response.json({ data: {
        shop: { myshopifyDomain: foreign ? "other.myshopify.com" : "robotto-7143.myshopify.com" },
        currentAppInstallation: { accessScopes: [{ handle: missingScope ? "read_products" : "write_files" }] },
        node: { id, fileStatus: "READY", url: fileUrl ?? `https://cdn.shopify.com/s/files/1/0766/2777/1738/files/llms-full.txt?v=${versionDrift ? version++ : version}` },
      } });
    }
    if (query.includes("StageRobottoCatalog")) {
      stages++;
      assert.equal(variables.input[0].resource, "FILE");
      return Response.json({ data: { stagedUploadsCreate: {
        stagedTargets: [{ url: staged + "/", resourceUrl: staged + "/" + stages,
          parameters: [{ name: "key", value: String(stages) }] }],
        userErrors: [],
      } } });
    }
    assert.match(query, /ReplaceRobottoCatalog/);
    assert.equal(variables.files.length, 1);
    assert.equal(variables.files[0].id, id);
    const key = new URL(variables.files[0].originalSource).pathname.slice(1);
    writes.push(key);
    version++;
    current = ambiguous ? bytes("External change") : payloads.get(key);
    if ((failAfterWrite || ambiguous) && writes.length === 1) throw new Error("Timeout");
    return Response.json({ data: { fileUpdate: { files: [{ id }], userErrors: [] } } });
  } };
  const transport = async (url, options) => {
    if (url.startsWith(publicUrl) || url.startsWith("https://cdn.shopify.com/")) {
      downloads.push(url);
      assert.equal(options.redirect, "error");
      // The unversioned cache deliberately never changes.
      if (url === publicUrl) return new Response(initial);
      return new Response(mismatch && url.startsWith(publicUrl) ? bytes("Wrong cache") : current);
    }
    assert.equal(url, staged + "/");
    assert.equal(options.redirect, "error");
    payloads.set(options.body.get("key"), new Uint8Array(await options.body.get("file").arrayBuffer()));
    return new Response(null, { status: 204 });
  };
  return {
    input: { admin, transport, wait: async () => {}, backup, candidate, expectedPreviousSha256: sha(backup) },
    writes, payloads, downloads, current: () => current,
  };
}

test("publication and rollback verify Shopify's current version despite stale unversioned cache", async () => {
  for (const failAfterWrite of [false, true]) {
    const f = fixture({ failAfterWrite });
    const result = await publishRobottoCatalog(f.input);
    assert.equal(result.status, failAfterWrite ? "ROLLED_BACK" : "PUBLISHED");
    assert.ok(f.downloads.some(url => url === publicUrl + "?v=2"));
    assert.ok(!f.downloads.includes(publicUrl));
    if (failAfterWrite) assert.ok(f.downloads.includes(publicUrl + "?v=3"));
  }
});

test("wrong file identity, missing or ambiguous versions, mismatched bytes and metadata races stop before writes", async () => {
  const base = "https://cdn.shopify.com/s/files/1/0766/2777/1738/files/llms-full.txt";
  for (const fileUrl of [base, base + "?v=x", base + "?v=1&v=2", base + "?v=1&other=2", base.replace("1738", "9999") + "?v=1", base + "?v=1#fragment"]) {
    const f = fixture({ fileUrl });
    await assert.rejects(publishRobottoCatalog(f.input), /SHOPIFY_FILE_URL_MISMATCH/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.downloads.length, 0);
  }
  for (const options of [{ mismatch: true }, { versionDrift: true }]) {
    const f = fixture(options);
    await assert.rejects(publishRobottoCatalog(f.input), /PUBLIC_HASH_NOT_VERIFIED/);
    assert.equal(f.writes.length, 0);
  }
});

test("daily Robotto catalog compares links and fails closed on incomplete or foreign data", async t => {
  const directory = await mkdtemp(join(tmpdir(), "robotto-daily-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shop = "robotto-7143.myshopify.com";
  const link = "https://www.robotto.se/products/item";
  const initial = bytes(`> Old intro\n\n## Products\n- [Old title](${link})`);
  const f = fixture({ initial });
  let count = 1;
  let url = link;
  let reads = 0;
  let checkedCollision = false;
  const admin = { async graphql(operation, options) {
    reads++;
    if (operation.includes("RobottoOnlineStoreCatalogCount")) {
      if (!checkedCollision) {
        checkedCollision = true;
        const calls = reads;
        await assert.rejects(run(), { code: "EEXIST" });
        await assert.rejects(publishRobottoCatalogWithBackup(directory, f.input), { code: "EEXIST" });
        assert.equal(reads, calls);
      }
      return Response.json({ data: { shop: { myshopifyDomain: shop }, productsCount: { count, precision: "EXACT" } } });
    }
    if (operation.includes("PublicLlmCatalog")) {
      assert.match(options.variables.filter, /published_status:online_store_channel/);
      return Response.json({ data: { products: {
        nodes: [{ legacyResourceId: "1", title: "New title", status: "ACTIVE", onlineStoreUrl: url }],
        pageInfo: { hasNextPage: false },
      } } });
    }
    return f.input.admin.graphql(operation, options);
  } };
  const run = (sessionShop = shop) => refreshRobottoOnlineStoreCatalog(directory, sessionShop, admin, f.input.transport);
  await assert.rejects(run("other.myshopify.com"), /INVALID_PILOT_TARGET/);
  assert.equal(reads, 0);
  assert.deepEqual(await run(), { status: "UNCHANGED", sha256: sha(initial) });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await readdir(directory), []);
  count = 2;
  await assert.rejects(run(), /ROBOTTO_CATALOG_INCOMPLETE/);
  assert.deepEqual(f.writes, []);
  count = 1;
  url = link + "-updated";
  assert.equal((await run()).status, "PUBLISHED");
  assert.equal(f.writes.length, 1);
  assert.deepEqual(await readFile(join(directory, `robotto-llms-full.${sha(initial)}.txt`)), Buffer.from(initial));
});

test("identical catalog skips all staging and writes", async () => {
  const f = fixture();
  assert.equal((await publishRobottoCatalog({ ...f.input, candidate: backup })).status, "UNCHANGED");
  assert.deepEqual(f.writes, []);
  assert.equal(f.payloads.size, 0);
});

test("changed catalog updates the pinned file and verifies public bytes", async () => {
  const f = fixture();
  assert.deepEqual(await publishRobottoCatalog(f.input), { status: "PUBLISHED", sha256: sha(candidate) });
  assert.deepEqual(f.writes, ["1"]);
  assert.deepEqual(f.current(), candidate);
});

test("lost update response rolls back only a publicly confirmed candidate", async () => {
  const f = fixture({ failAfterWrite: true });
  assert.deepEqual(await publishRobottoCatalog(f.input), { status: "ROLLED_BACK", sha256: sha(backup) });
  assert.deepEqual(f.writes, ["1", "2"]);
  assert.deepEqual(f.current(), backup);
});

test("foreign shop, missing write scope, baseline drift and ambiguous external change fail closed", async () => {
  for (const options of [{ drift: true }, { foreign: true }, { missingScope: true }]) {
    const f = fixture(options);
    await assert.rejects(publishRobottoCatalog(f.input), /PUBLIC_BASELINE_DRIFT|SHOP_OR_FILE_MISMATCH|WRITE_FILES_NOT_GRANTED/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.payloads.size, 0);
  }
  const f = fixture({ ambiguous: true });
  await assert.rejects(publishRobottoCatalog(f.input), /PUBLICATION_UNCONFIRMED/);
  assert.deepEqual(f.writes, ["1"]);
});

test("persists verified backup before contacting Shopify and blocks a second run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "robotto-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture({ failAfterWrite: true });
  const name = `robotto-llms-full.${sha(backup)}.txt`;
  let checked = false;
  const admin = { graphql: async (...args) => {
    if (!checked) {
      checked = true;
      assert.equal(sha(await readFile(join(directory, name))), sha(backup));
      await assert.rejects(publishRobottoCatalogWithBackup(directory, f.input), { code: "EEXIST" });
    }
    return f.input.admin.graphql(...args);
  } };
  assert.equal((await publishRobottoCatalogWithBackup(directory, { ...f.input, admin })).status, "ROLLED_BACK");
  assert.deepEqual(await readdir(directory), [name]);
  assert.equal(sha(await readFile(join(directory, name))), sha(backup));
});

test("a corrupted persisted backup stops before any provider call", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "robotto-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = `robotto-llms-full.${sha(backup)}.txt`;
  await writeFile(join(directory, name), "corrupt");
  const f = fixture();
  const admin = { graphql: async () => assert.fail("Unexpected Shopify call") };
  await assert.rejects(publishRobottoCatalogWithBackup(directory, { ...f.input, admin }), /PERSISTED_BACKUP_MISMATCH/);
  assert.deepEqual(await readdir(directory), [name]);
  assert.equal(await readFile(join(directory, name), "utf8"), "corrupt");
});
