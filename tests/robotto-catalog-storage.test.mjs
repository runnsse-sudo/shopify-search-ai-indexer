import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { robottoCatalogStorage } from "../app/services/llm-visibility/robotto-catalog-storage.server.ts";

test("Cloud Storage excludes independent callers and preserves generation-bound backup across clients", async () => {
  const bucket = "test-robotto";
  const objects = new Map();
  let generation = 0;
  let corrupt = false;
  const transport = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "metadata.google.internal") {
      return Response.json({ access_token: "synthetic" }, { headers: { "Metadata-Flavor": "Google" } });
    }
    assert.equal(url.hostname, "storage.googleapis.com");
    const name = url.searchParams.get("name") ?? decodeURIComponent(url.pathname.split("/").at(-1));
    const current = objects.get(name);
    if (options.method === "POST") {
      assert.equal(url.searchParams.get("ifGenerationMatch"), "0");
      if (current) return new Response(null, { status: 412 });
      const item = { bucket, name, generation: String(++generation), bytes: Buffer.from(options.body) };
      objects.set(name, item);
      return Response.json(item);
    }
    if (options.method === "DELETE") {
      assert.equal(url.searchParams.get("ifGenerationMatch"), current.generation);
      objects.delete(name);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get("alt") === "media") {
      assert.equal(url.searchParams.get("generation"), current.generation);
      return new Response(corrupt ? Buffer.from("bad") : current.bytes);
    }
    return Response.json(current);
  };
  const client = robottoCatalogStorage(bucket, transport);
  const other = robottoCatalogStorage(bucket, transport);
  const bytes = Buffer.from("old catalog");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await client.withLock(async () => {
    await assert.rejects(other.withLock(() => assert.fail("competing caller ran")), /LOCKED/);
    assert.deepEqual(await client.persistBackup(bytes, digest), bytes);
  });
  await other.withLock(async () => assert.deepEqual(await other.persistBackup(bytes, digest), bytes));
  corrupt = true;
  await assert.rejects(client.withLock(() => client.persistBackup(bytes, digest)), /BACKUP_MISMATCH/);
  await assert.rejects(other.withLock(() => assert.fail("uncertain lock was removed")), /LOCKED/);
  assert.equal(objects.size, 2);
});
