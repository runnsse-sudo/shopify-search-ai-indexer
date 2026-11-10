import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CATALOG_SHOPS,
  catalogPrefix,
  parseCatalogTargets,
  validateCatalogTarget,
} from "../app/services/llm-visibility/multishop-catalog-targets.ts";
import { catalogPublisher } from "../app/services/llm-visibility/multishop-catalog-publication.server.ts";
import { catalogStorage } from "../app/services/llm-visibility/multishop-catalog-storage.server.ts";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const target = (i) => ({
  shop: CATALOG_SHOPS[i],
  primaryDomain: `store${i}.example`,
  fileId: `gid://shopify/GenericFile/${i + 1}`,
  cdnPath: `/s/files/1/0000/000${i}/files/llms-full.txt`,
});
const text = (t, handle = "old") =>
  Buffer.from(
    `# ${t.primaryDomain}\n\n## Products\n- [Product](https://${t.primaryDomain}/products/${handle})\n`,
  );

function provider(t, options = {}) {
  let current = text(t, options.previousHandle ?? "old");
  let version = 1;
  let metadataReads = 0,
    ownReads = 0,
    postWriteOwnReads = 0,
    waits = 0;
  const payloads = new Map();
  const calls = [];
  const writes = [];
  let state = options.initialState ?? null;
  let locked = false;
  const backups = new Map();
  const storage = {
    shop: t.shop,
    async withLock(run) {
      if (locked || options.locked)
        throw new Error("CATALOG_PUBLICATION_LOCKED");
      locked = true;
      const result = await run();
      locked = false;
      return result;
    },
    async readDailyState() {
      return state;
    },
    async saveDailyState(value) {
      assert.ok(locked);
      if (options.stateFailure) throw new Error("CATALOG_STATE_UNVERIFIED");
      state = value;
    },
    async persistBackup(bytes, digest) {
      assert.ok(locked);
      assert.equal(sha(bytes), digest);
      if (options.backupFailure) throw new Error("PERSISTED_BACKUP_MISMATCH");
      backups.set(digest, Buffer.from(bytes));
      return options.backupReadbackMismatch
        ? Buffer.from("bad stored bytes")
        : Buffer.from(bytes);
    },
  };
  const admin = {
    async graphql(operation, args) {
      calls.push(operation);
      if (operation.includes("DailyCatalogCount"))
        return Response.json({
          data: {
            shop: {
              myshopifyDomain: options.foreignShop ?? t.shop,
              primaryDomain: { host: options.foreignDomain ?? t.primaryDomain },
            },
            productsCount: {
              count: options.incomplete ? 2 : 1,
              precision: "EXACT",
            },
          },
        });
      if (operation.includes("PublicLlmCatalog")) {
        assert.match(args.variables.filter, /online_store_channel/);
        return Response.json({
          data: {
            products: {
              nodes: [
                {
                  legacyResourceId: "1",
                  title: "Product",
                  status: "ACTIVE",
                  onlineStoreUrl: `https://${t.primaryDomain}/products/${options.handle ?? (options.unchanged ? "old" : "new")}`,
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      if (operation.includes("ReadRobottoCatalog")) {
        metadataReads++;
        assert.equal(args.variables.id, t.fileId);
        return Response.json({
          data: {
            shop: { myshopifyDomain: t.shop },
            currentAppInstallation: {
              accessScopes: [
                {
                  handle: options.missingScope
                    ? "read_products"
                    : "write_files",
                },
              ],
            },
            node: {
              id: t.fileId,
              fileStatus:
                options.notReadyOnSecond && metadataReads === 2
                  ? "PROCESSING"
                  : "READY",
              url: `https://cdn.shopify.com${options.wrongCdn ?? t.cdnPath}?v=${(options.metadataDrift && metadataReads === 2) || (options.crossRetryDrift && metadataReads > 2) ? version + 1 : version}`,
            },
          },
        });
      }
      if (operation.includes("StageRobottoCatalog")) {
        assert.equal(backups.size, 1, "durable backup before staging");
        const key = String(payloads.size + 1);
        payloads.set(key, null);
        return Response.json({
          data: {
            stagedUploadsCreate: {
              stagedTargets: [
                {
                  url: "https://shopify-staged-uploads.storage.googleapis.com/",
                  resourceUrl: `https://shopify-staged-uploads.storage.googleapis.com/${key}`,
                  parameters: [{ name: "key", value: key }],
                },
              ],
              userErrors: [],
            },
          },
        });
      }
      assert.match(operation, /ReplaceRobottoCatalog/);
      assert.equal(args.variables.files[0].id, t.fileId);
      writes.push(args.variables.files[0]);
      const key = new URL(
        args.variables.files[0].originalSource,
      ).pathname.slice(1);
      current = options.ambiguous
        ? text(t, "foreign-change")
        : payloads.get(key);
      version++;
      if ((options.lostResponse || options.ambiguous) && writes.length === 1)
        throw new Error("Timeout");
      return Response.json({
        data: { fileUpdate: { files: [{ id: t.fileId }], userErrors: [] } },
      });
    },
  };
  const transport = async (input, init) => {
    const url = new URL(input);
    assert.equal(init.redirect, "error");
    if (url.hostname === "shopify-staged-uploads.storage.googleapis.com") {
      payloads.set(
        init.body.get("key"),
        Buffer.from(await init.body.get("file").arrayBuffer()),
      );
      return new Response(null, { status: 204 });
    }
    assert.ok(["cdn.shopify.com", t.primaryDomain].includes(url.hostname));
    if (url.pathname === "/llms-full.txt")
      return new Response(
        options.discovery ??
          `- [Catalog](https://${t.primaryDomain}/cdn/shop/files/${t.cdnPath.split("/").at(-1)}?v=1)\n`,
      );
    assert.match(url.search, /^\?v=\d+$/);
    if (options.shaAfterBackupDrift && backups.size)
      return new Response(text(t, "changed-after-backup"));
    if (url.hostname === t.primaryDomain) {
      ownReads++;
      if (writes.length) postWriteOwnReads++;
      if (
        (!writes.length && ownReads <= (options.initialMismatchReads ?? 0)) ||
        (writes.length &&
          postWriteOwnReads <= (options.postWriteMismatchReads ?? 0))
      )
        return new Response(text(t, "cached-old-version"));
    }
    return new Response(
      options.badReadback && version > 1 ? text(t, "wrong") : current,
    );
  };
  return {
    admin,
    storage,
    transport,
    calls,
    writes,
    backups,
    payloads,
    current: () => current,
    state: () => state,
    locked: () => locked,
    waits: () => waits,
    ownReads: () => ownReads,
    run: (clock = () => 100_000_000) =>
      catalogPublisher(t, options.onPhase).refresh(
        storage,
        t.shop,
        admin,
        transport,
        clock,
        async () => {
          waits++;
        },
      ),
  };
}

test("six store identities are isolated; unknown, duplicate and unsafe targets rejected", () => {
  assert.equal(CATALOG_SHOPS.length, 6);
  assert.equal(new Set(CATALOG_SHOPS.map(catalogPrefix)).size, 6);
  assert.equal(catalogPrefix(CATALOG_SHOPS[2]), "robotto/llms-full/");
  assert.equal(
    parseCatalogTargets(JSON.stringify(CATALOG_SHOPS.map((_, i) => target(i))))
      .length,
    6,
  );
  for (const value of [
    { ...target(0), shop: "other.myshopify.com" },
    { ...target(0), primaryDomain: "127.0.0.1" },
    { ...target(0), primaryDomain: "host.example/path" },
    { ...target(0), fileId: "gid://shopify/Product/1" },
    { ...target(0), cdnPath: "/s/files/1/0000/0000/files/private.txt" },
  ]) {
    assert.throws(() => validateCatalogTarget(value), /INVALID_CATALOG_TARGET/);
  }
  for (const key of ["shop", "primaryDomain", "fileId", "cdnPath"]) {
    assert.throws(
      () =>
        parseCatalogTargets(
          JSON.stringify([target(0), { ...target(1), [key]: target(0)[key] }]),
        ),
      /COLLISION/,
    );
  }
});

for (let i = 0; i < 6; i++)
  test(`complete generate/backup/publish/readback/once-per-day for ${CATALOG_SHOPS[i]}`, async () => {
    const t = target(i),
      f = provider(t);
    assert.equal((await f.run()).status, "PUBLISHED");
    assert.equal(f.writes.length, 1);
    assert.equal(f.state().sha256, sha(f.current()));
    assert.equal(f.backups.size, 1);
    const calls = f.calls.length;
    assert.equal((await f.run()).status, "NOT_DUE");
    assert.equal(f.calls.length, calls);
    assert.equal(f.writes.length, 1);
    const restarted = catalogPublisher(t);
    assert.equal(
      (
        await restarted.refresh(
          f.storage,
          t.shop,
          f.admin,
          f.transport,
          () => 186_400_000,
        )
      ).status,
      "UNCHANGED",
    );
    assert.equal(f.writes.length, 1);
  });

test("fixed daily schedule remains due after previous completion delay and restart", async () => {
  const t = target(0),
    f = provider(t);
  const start = Date.UTC(2026, 10, 8, 3);
  let tick = 0;
  await f.run(() => (tick++ === 0 ? start : start + 120_000));
  assert.equal(f.state().completedAt, start + 120_000);
  const calls = f.calls.length;
  assert.equal((await f.run(() => start + 3_600_000)).status, "NOT_DUE");
  assert.equal(f.calls.length, calls);
  const restarted = catalogPublisher(t);
  assert.equal(
    (
      await restarted.refresh(
        f.storage,
        t.shop,
        f.admin,
        f.transport,
        () => start + 86_400_000,
      )
    ).status,
    "UNCHANGED",
  );
  assert.equal(f.writes.length, 1);
  const nextCalls = f.calls.length;
  assert.equal((await f.run(() => start + 86_400_000 + 1)).status, "NOT_DUE");
  assert.equal(f.calls.length, nextCalls);
});

test("UTC day boundary is due without local timezone or DST assumptions", async () => {
  const f = provider(target(0), { unchanged: true });
  const midnight = Date.UTC(2026, 9, 25);
  await f.run(() => midnight - 1);
  assert.equal((await f.run(() => midnight)).status, "UNCHANGED");
  const calls = f.calls.length;
  assert.equal(
    (await f.run(() => midnight + 86_400_000 - 1)).status,
    "NOT_DUE",
  );
  assert.equal(f.calls.length, calls);
  assert.equal(f.writes.length, 0);
});

test("future completion timestamp remains blocked before Shopify access", async () => {
  const f = provider(target(0), { unchanged: true });
  const completed = Date.UTC(2026, 10, 8, 3);
  await f.run(() => completed);
  const calls = f.calls.length;
  await assert.rejects(
    f.run(() => completed - 1),
    /CATALOG_CLOCK_DRIFT/,
  );
  assert.equal(f.calls.length, calls);
  assert.equal(f.writes.length, 0);
});

test("unchanged links skip staging, publication and backup", async () => {
  const f = provider(target(0), { unchanged: true });
  assert.equal((await f.run()).status, "UNCHANGED");
  assert.equal(f.payloads.size, 0);
  assert.equal(f.backups.size, 0);
  assert.equal(f.writes.length, 0);
});

test("wrong session or storage rejected before provider access", async () => {
  const t = target(0),
    f = provider(t),
    publisher = catalogPublisher(t);
  await assert.rejects(
    publisher.refresh(f.storage, CATALOG_SHOPS[1], f.admin, f.transport),
    /TENANT_MISMATCH/,
  );
  await assert.rejects(
    publisher.refresh(
      { ...f.storage, shop: CATALOG_SHOPS[1] },
      t.shop,
      f.admin,
      f.transport,
    ),
    /TENANT_MISMATCH/,
  );
  assert.equal(f.calls.length, 0);
});

test("identity, domain, completeness, scope and CDN binding stop before mutations", async () => {
  for (const options of [
    { foreignShop: CATALOG_SHOPS[1] },
    { foreignDomain: "other.example" },
    { incomplete: true },
    { missingScope: true },
    { wrongCdn: target(1).cdnPath },
  ]) {
    const f = provider(target(0), options);
    await assert.rejects(
      f.run(),
      /COUNT_UNVERIFIED|INCOMPLETE|NOT_GRANTED|URL_MISMATCH/,
    );
    assert.equal(f.writes.length, 0);
    assert.equal(f.state(), null);
  }
});

test("lost write response restores only confirmed candidate and does not mark daily success", async () => {
  const t = target(0),
    f = provider(t, { lostResponse: true });
  assert.equal((await f.run()).status, "ROLLED_BACK");
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.current(), text(t));
  assert.equal(f.state(), null);
});

test("uncertain publication retains lock; no automatic rollback over foreign changes", async () => {
  const f = provider(target(0), { ambiguous: true });
  await assert.rejects(f.run(), /PUBLICATION_UNCONFIRMED/);
  assert.equal(f.writes.length, 1);
  assert.equal(f.locked(), true);
  assert.equal(f.state(), null);
  await assert.rejects(f.run(), /LOCKED/);
});

test("checkpoint error stops, retains lock and never repeats published mutation", async () => {
  const f = provider(target(0), { stateFailure: true });
  await assert.rejects(f.run(), /STATE_UNVERIFIED/);
  await assert.rejects(f.run(), /LOCKED/);
  assert.equal(f.writes.length, 1);
});

test("shared locks conflict only within same store; backups/checkpoints survive client restart", async () => {
  const objects = new Map();
  let generation = 0;
  const bucket = "test-catalogs";
  let corrupt = false;
  const transport = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "metadata.google.internal")
      return Response.json(
        { access_token: "synthetic" },
        { headers: { "Metadata-Flavor": "Google" } },
      );
    assert.equal(url.hostname, "storage.googleapis.com");
    const name =
      url.searchParams.get("name") ??
      decodeURIComponent(url.pathname.split("/").at(-1));
    const current = objects.get(name);
    if (options.method === "POST") {
      if (
        url.searchParams.get("ifGenerationMatch") !==
        (current?.generation ?? "0")
      )
        return new Response(null, { status: 412 });
      const item = {
        bucket,
        name,
        generation: String(++generation),
        bytes: Buffer.from(options.body),
      };
      objects.set(name, item);
      return Response.json(item);
    }
    if (!current) return new Response(null, { status: 404 });
    if (options.method === "DELETE") {
      assert.equal(
        url.searchParams.get("ifGenerationMatch"),
        current.generation,
      );
      objects.delete(name);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get("alt") === "media") {
      assert.equal(url.searchParams.get("generation"), current.generation);
      return new Response(corrupt ? "bad" : current.bytes);
    }
    return Response.json(current);
  };
  const a = catalogStorage(bucket, CATALOG_SHOPS[0], transport);
  const restart = catalogStorage(bucket, CATALOG_SHOPS[0], transport);
  const b = catalogStorage(bucket, CATALOG_SHOPS[1], transport);
  const data = text(target(0));
  const state = {
    completedAt: 1000,
    sha256: sha(data),
    targetSha256: sha("target"),
  };
  await assert.rejects(a.persistBackup(data, sha(data)), /LOCK_REQUIRED/);
  await a.withLock(async () => {
    // Mock provider returns precondition failure for an existing lock.
    const storedLock = objects.get(catalogPrefix(a.shop) + "publication.lock");
    assert.ok(storedLock);
    await assert.rejects(
      restart.withLock(() => assert.fail("competing run")),
      /LOCKED/,
    );
    await b.withLock(async () => {
      assert.equal(await b.readDailyState(), null);
    });
    assert.equal(await a.readDailyState(), null);
    assert.deepEqual(await a.persistBackup(data, sha(data)), data);
    await a.saveDailyState(state);
  });
  await restart.withLock(async () => {
    assert.deepEqual(await restart.readDailyState(), state);
    assert.deepEqual(await restart.persistBackup(data, sha(data)), data);
    await restart.saveDailyState({ ...state, completedAt: 2000 });
  });
  corrupt = true;
  await assert.rejects(
    a.withLock(() => a.persistBackup(data, sha(data))),
    /BACKUP/,
  );
  await assert.rejects(
    restart.withLock(() => assert.fail("uncertain lock released")),
    /LOCKED/,
  );
});

test("successful checkpoint rejects clock reversal and target rebinding without Shopify reads", async () => {
  const t = target(0),
    f = provider(t, { unchanged: true });
  await f.run();
  const calls = f.calls.length;
  await assert.rejects(
    f.run(() => 99_999_999),
    /CLOCK_DRIFT/,
  );
  assert.equal(f.calls.length, calls);
  const other = provider(t, { unchanged: true });
  await other.run();
  const count = other.calls.length;
  await assert.rejects(
    catalogPublisher({ ...t, fileId: "gid://shopify/GenericFile/999" }).refresh(
      other.storage,
      t.shop,
      other.admin,
      other.transport,
      () => 100_000_001,
    ),
    /STATE_TARGET_DRIFT/,
  );
  assert.equal(other.calls.length, count);
});

test("independent stores cannot share candidate or backup content", async () => {
  const a = provider(target(0));
  const b = provider(target(1));
  await Promise.all([a.run(), b.run()]);
  assert.notEqual(sha(a.current()), sha(b.current()));
  assert.deepEqual([...a.backups.values()], [text(target(0))]);
  assert.deepEqual([...b.backups.values()], [text(target(1))]);
  for (const write of a.writes) assert.equal(write.id, target(0).fileId);
  for (const write of b.writes) assert.equal(write.id, target(1).fileId);
});

test("corrupt or cross-shop durable checkpoint blocks without releasing its lock", async () => {
  let removed = false;
  const t = target(0);
  const bucket = "test-catalogs";
  const prefix = catalogPrefix(t.shop);
  const transport = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "metadata.google.internal")
      return Response.json(
        { access_token: "synthetic" },
        { headers: { "Metadata-Flavor": "Google" } },
      );
    const name =
      url.searchParams.get("name") ??
      decodeURIComponent(url.pathname.split("/").at(-1));
    if (options.method === "DELETE") {
      removed = true;
      throw new Error("Unexpected release");
    }
    if (url.searchParams.get("alt") === "media")
      return Response.json({
        shop: target(1).shop,
        completedAt: 1000,
        sha256: sha("catalog"),
        targetSha256: sha("target"),
      });
    return Response.json({
      bucket,
      name: name.startsWith(prefix) ? name : prefix + name,
      generation: "1",
    });
  };
  const storage = catalogStorage(bucket, t.shop, transport);
  await assert.rejects(
    storage.withLock(() => storage.readDailyState()),
    /STATE_UNVERIFIED/,
  );
  assert.equal(removed, false);
});

// Terminal failures retain lock/state semantics; only bounded read-only CDN retries are allowed.
for (const scenario of [
  "count",
  "generation",
  "invalid-encoded-handle",
  "public-readback",
  "backup",
  "stage",
  "update",
  "checkpoint",
]) {
  test(`diagnostic phase and original stop/lock semantics: ${scenario}`, async () => {
    let phase;
    const t = target(1);
    const f = provider(t, {
      onPhase: (next) => {
        phase = next;
      },
    });
    const original = f.admin.graphql;
    f.admin.graphql = async (operation, args) => {
      if (scenario === "count" && operation.includes("DailyCatalogCount"))
        return Response.json({
          data: null,
          errors: [{ message: "private provider data" }],
        });
      if (scenario === "generation" && operation.includes("PublicLlmCatalog"))
        throw new Error("CATALOG_URL_MISMATCH");
      if (
        scenario === "invalid-encoded-handle" &&
        operation.includes("PublicLlmCatalog")
      )
        return Response.json({
          data: {
            products: {
              nodes: [
                {
                  legacyResourceId: "1",
                  title: "Synthetic public product",
                  status: "ACTIVE",
                  onlineStoreUrl: `https://${t.primaryDomain}/products/synthetic%C2-product`,
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      if (scenario === "stage" && operation.includes("StageRobottoCatalog"))
        return Response.json({
          data: {
            stagedUploadsCreate: {
              stagedTargets: [],
              userErrors: [{ message: "private upload target" }],
            },
          },
        });
      if (scenario === "update" && operation.includes("ReplaceRobottoCatalog"))
        return Response.json({
          data: {
            fileUpdate: {
              files: [],
              userErrors: [{ message: "private file detail" }],
            },
          },
        });
      return original(operation, args);
    };
    if (scenario === "backup")
      f.storage.persistBackup = async () => {
        throw new Error("PERSISTED_BACKUP_MISMATCH");
      };
    if (scenario === "checkpoint")
      f.storage.saveDailyState = async () => {
        throw new Error("CATALOG_STATE_UNVERIFIED");
      };
    const transport =
      scenario === "public-readback"
        ? async (url) =>
            new Response(
              new URL(url).hostname === t.primaryDomain
                ? text(t, "foreign")
                : text(t),
            )
        : f.transport;
    const expected = {
      count: ["catalog_count", "CATALOG_COUNT_UNVERIFIED"],
      generation: ["catalog_generate", "CATALOG_URL_MISMATCH"],
      "invalid-encoded-handle": ["catalog_generate", "CATALOG_URL_MISMATCH"],
      "public-readback": ["public_verify", "PUBLIC_CDN_HASH_MISMATCH"],
      backup: ["backup", "PERSISTED_BACKUP_MISMATCH"],
      stage: ["stage", "STAGING_REJECTED"],
      update: ["public_verify", "PUBLICATION_UNCONFIRMED"],
      checkpoint: ["checkpoint_write", "CATALOG_STATE_UNVERIFIED"],
    }[scenario];
    await assert.rejects(
      catalogPublisher(t, (next) => {
        phase = next;
      }).refresh(
        f.storage,
        t.shop,
        f.admin,
        transport,
        () => 100_000_000,
        async () => {},
      ),
      (error) => {
        assert.equal(error.message, expected[1]);
        if (scenario === "update")
          assert.equal(error.cause.message, "FILE_UPDATE_REJECTED");
        return true;
      },
    );
    assert.equal(phase, expected[0]);
    assert.equal(f.locked(), true);
    assert.equal(f.state(), null);
    assert.equal(f.writes.length, scenario === "checkpoint" ? 1 : 0);
  });
}

test("diagnostics cover successful checkpoint and release without extra provider calls", async () => {
  const phases = [];
  const f = provider(target(0), { onPhase: (p) => phases.push(p) });
  assert.equal((await f.run()).status, "PUBLISHED");
  for (const phase of [
    "lock",
    "checkpoint_read",
    "session",
    "catalog_count",
    "catalog_generate",
    "file_metadata",
    "public_read",
    "public_verify",
    "compare_links",
    "backup",
    "stage",
    "upload",
    "file_update",
    "checkpoint_write",
    "lock_release",
  ])
    assert.ok(phases.includes(phase), phase);
  assert.equal(f.locked(), false);
  assert.equal(f.writes.length, 1);
  const calls = f.calls.length;
  phases.length = 0;
  assert.equal((await f.run()).status, "NOT_DUE");
  assert.deepEqual(phases, ["lock", "checkpoint_read", "lock_release"]);
  assert.equal(f.calls.length, calls);
});

for (const release of [false, true]) {
  test(`lock ${release ? "release" : "acquisition"} failure preserves diagnostics and never retries`, async () => {
    const t = target(0);
    const f = provider(t);
    let phase;
    let attempts = 0;
    const original = f.storage.withLock;
    f.storage.withLock = async (run) => {
      attempts++;
      if (!release) throw new Error("CATALOG_PUBLICATION_LOCKED");
      return original(async () => {
        await run();
        throw new Error("CATALOG_LOCK_RELEASE_UNCONFIRMED");
      });
    };
    await assert.rejects(
      catalogPublisher(t, (p) => {
        phase = p;
      }).refresh(f.storage, t.shop, f.admin, f.transport, () => 100_000_000),
      release ? /LOCK_RELEASE_UNCONFIRMED/ : /PUBLICATION_LOCKED/,
    );
    assert.equal(phase, release ? "lock_release" : "lock");
    assert.equal(attempts, 1);
    assert.equal(f.writes.length, release ? 1 : 0);
    if (release) assert.equal(f.locked(), true);
    else assert.equal(f.calls.length, 0);
  });
}

for (const handle of [
  "kos%C2%AE-par-puca%C2%AE-opaque",
  "dropduo%C2%AE-crystal",
  "wibeduo%c2%ae-metallic",
]) {
  test(`valid percent-encoded product survives generate, backup, publication and checkpoint: ${handle}`, async () => {
    const t = target(1);
    const f = provider(t, { handle });
    assert.equal((await f.run()).status, "PUBLISHED");
    assert.ok(f.current().toString().includes(`/products/${handle})`));
    assert.equal(f.backups.size, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.state().sha256, sha(f.current()));
    assert.equal(f.locked(), false);
    assert.equal((await f.run()).status, "NOT_DUE");
    assert.equal(f.writes.length, 1);
  });
}

test("encoded-path checks preserve previously accepted ASCII backup paths", async () => {
  const f = provider(target(1), {
    previousHandle: "old~handle",
    handle: "new%C2%AE-handle",
  });
  assert.equal((await f.run()).status, "PUBLISHED");
  assert.equal(f.backups.size, 1);
  assert.equal(f.locked(), false);
});

test("stable CDN propagation mismatch before backup is retried without mutations", async () => {
  const f = provider(target(0), { unchanged: true, initialMismatchReads: 2 });
  assert.equal((await f.run()).status, "UNCHANGED");
  assert.equal(f.waits(), 2);
  assert.equal(f.writes.length, 0);
  assert.equal(f.backups.size, 0);
  assert.equal(f.locked(), false);
});
test("persistent baseline CDN mismatch stops at six reads and retains lock", async () => {
  const f = provider(target(0), { initialMismatchReads: 100 });
  await assert.rejects(f.run(), (e) => {
    assert.equal(e.message, "PUBLIC_CDN_HASH_MISMATCH");
    assert.notEqual(e.evidence.canonicalSha256, e.evidence.downloadSha256);
    assert.equal(e.evidence.beforeVersion, e.evidence.afterVersion);
    return true;
  });
  assert.equal(f.waits(), 5);
  assert.equal(f.ownReads(), 6);
  assert.equal(f.writes.length, 0);
  assert.equal(f.backups.size, 0);
  assert.equal(f.state(), null);
  assert.equal(f.locked(), true);
});
for (const options of [{ metadataDrift: true }, { notReadyOnSecond: true }])
  test(
    "metadata/READY drift is not retried as CDN delay " +
      JSON.stringify(options),
    async () => {
      const f = provider(target(0), options);
      await assert.rejects(f.run(), /PUBLIC_FILE_VERSION_DRIFT/);
      assert.equal(f.waits(), 0);
      assert.equal(f.writes.length, 0);
      assert.equal(f.backups.size, 0);
      assert.equal(f.locked(), true);
    },
  );
test("CDN propagation after replace recovers with one write and verified backup", async () => {
  const f = provider(target(0), { postWriteMismatchReads: 2 });
  assert.equal((await f.run()).status, "PUBLISHED");
  assert.equal(f.waits(), 2);
  assert.equal(f.writes.length, 1);
  assert.equal(f.backups.size, 1);
  assert.ok(f.state());
  assert.equal(f.locked(), false);
});
test("persistent post-write mismatch preserves original error through uncertain rollback preflight", async () => {
  const f = provider(target(0), { postWriteMismatchReads: 100 });
  await assert.rejects(f.run(), (e) => {
    assert.equal(e.message, "PUBLICATION_UNCONFIRMED");
    assert.equal(e.cause.message, "PUBLIC_CDN_HASH_MISMATCH");
    assert.equal(e.cause.evidence.beforeVersion, "2");
    return true;
  });
  assert.equal(f.waits(), 5);
  assert.equal(f.writes.length, 1, "no blind rollback");
  assert.equal(f.backups.size, 1);
  assert.equal(f.state(), null);
  assert.equal(f.locked(), true);
});

test("version changes between CDN retries stop without accepting new baseline", async () => {
  const f = provider(target(0), {
    initialMismatchReads: 1,
    crossRetryDrift: true,
  });
  await assert.rejects(f.run(), /PUBLIC_FILE_VERSION_DRIFT/);
  assert.equal(f.waits(), 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.backups.size, 0);
  assert.equal(f.locked(), true);
});

function addressedTarget() {
  const t = {
    shop: "94d715-94.myshopify.com",
    primaryDomain: "www.felkodslasare.se",
    fileId: "gid://shopify/GenericFile/77590315368716",
  };
  const digest = sha(text(t));
  return {
    ...t,
    cdnPath: `/s/files/1/0746/4979/6876/files/llms-full-${digest}.txt`,
    contentSha256: digest,
  };
}
test("SHA-bound Felk target is explicit and legacy target serialization stays unchanged", () => {
  const t = addressedTarget();
  assert.deepEqual(validateCatalogTarget(t), t);
  for (let i = 0; i < 6; i++)
    assert.deepEqual(validateCatalogTarget(target(i)), target(i));
  for (const bad of [
    { ...t, shop: CATALOG_SHOPS[0] },
    { ...t, primaryDomain: "foreign.example" },
    { ...t, contentSha256: "a".repeat(64) },
    { ...t, contentSha256: null },
    { ...t, fileId: "gid://shopify/GenericFile/77579264491788" },
    { ...t, contentSha256: undefined },
    { ...t, cdnPath: t.cdnPath + "?v=1" },
  ])
    assert.throws(() => validateCatalogTarget(bad), /INVALID_CATALOG_TARGET/);
});
test("unchanged SHA-bound daily catalogue only checkpoints verified current generation", async () => {
  const t = addressedTarget(),
    f = provider(t, { unchanged: true });
  const result = await f.run();
  assert.equal(result.status, "UNCHANGED");
  assert.equal(result.sha256, t.contentSha256);
  assert.equal(f.state().targetSha256, sha(Buffer.from(JSON.stringify(t))));
  assert.equal(f.writes.length, 0);
  assert.equal(f.payloads.size, 0);
  assert.equal(f.backups.size, 0);
  assert.equal(f.locked(), false);
  assert.equal((await f.run()).status, "NOT_DUE");
  assert.equal((await f.run(() => 2 * 86400000)).status, "UNCHANGED");
});
test("changed SHA-bound daily catalogue prepares handover, backs up current bytes and never publishes", async () => {
  const t = addressedTarget(),
    f = provider(t);
  const result = await f.run();
  assert.equal(result.status, "LINK_UPDATE_REQUIRED");
  assert.equal(result.currentFileId, t.fileId);
  assert.notEqual(result.nextSha256, t.contentSha256);
  assert.equal(result.nextFilename, `llms-full-${result.nextSha256}.txt`);
  assert.equal(result.requiresSeparateCandidateAndLinkApproval, true);
  assert.equal(f.state(), null);
  assert.equal(f.writes.length, 0);
  assert.equal(f.payloads.size, 0);
  assert.equal(f.backups.size, 1);
  assert.equal(f.locked(), false);
});
for (const [name, options, code] of [
  ["missing scope", { missingScope: true }, "WRITE_FILES_NOT_GRANTED"],
  [
    "foreign shop",
    { foreignShop: CATALOG_SHOPS[0] },
    "CATALOG_COUNT_UNVERIFIED",
  ],
  [
    "metadata version drift",
    { metadataDrift: true },
    "PUBLIC_FILE_VERSION_DRIFT",
  ],
  ["CDN mismatch", { initialMismatchReads: 1 }, "PUBLIC_HASH_NOT_VERIFIED"],
  [
    "wrong filename",
    { wrongCdn: "/s/files/1/0746/4979/6876/files/llms-full.txt" },
    "SHOPIFY_FILE_URL_MISMATCH",
  ],
  [
    "stale discovery",
    {
      discovery:
        "- [Catalog](https://www.felkodslasare.se/cdn/shop/files/llms-full.txt?v=1)",
    },
    "CATALOG_DISCOVERY_DRIFT",
  ],
  ["missing discovery", { discovery: "# no link" }, "CATALOG_DISCOVERY_DRIFT"],
  [
    "ambiguous discovery",
    {
      discovery:
        "- [One](https://www.felkodslasare.se/llms-full.txt)\n- [Two](https://www.felkodslasare.se/llms-full.txt)",
    },
    "CATALOG_DISCOVERY_DRIFT",
  ],
  ["backup failure", { backupFailure: true }, "PERSISTED_BACKUP_MISMATCH"],
  ["incomplete catalogue", { incomplete: true }, "CATALOG_INCOMPLETE"],
])
  test(`SHA daily blocks ${name} before any staging/mutation/checkpoint`, async () => {
    const f = provider(addressedTarget(), options);
    await assert.rejects(f.run(), new RegExp(code));
    assert.equal(f.writes.length, 0);
    assert.equal(f.payloads.size, 0);
    assert.equal(f.state(), null);
    assert.equal(f.locked(), true, "preserve uncertain lock");
  });
test("SHA-bound file cannot be repurposed by target hash drift", async () => {
  const f = provider(addressedTarget(), {
    previousHandle: "other",
    unchanged: true,
  });
  await assert.rejects(f.run(), /PUBLIC_HASH_NOT_VERIFIED/);
  assert.equal(f.writes.length, 0);
});

for (const [name, options, code] of [
  ["concurrent lock", { locked: true }, "CATALOG_PUBLICATION_LOCKED"],
  [
    "wrong stored backup",
    { backupReadbackMismatch: true },
    "PERSISTED_BACKUP_MISMATCH",
  ],
  [
    "bytes drift after backup",
    { shaAfterBackupDrift: true },
    "PUBLIC_HASH_NOT_VERIFIED",
  ],
  [
    "old target checkpoint",
    {
      initialState: {
        completedAt: 0,
        sha256: "a".repeat(64),
        targetSha256: "b".repeat(64),
      },
    },
    "CATALOG_STATE_TARGET_DRIFT",
  ],
])
  test(`SHA daily blocks ${name} without mutation`, async () => {
    const f = provider(addressedTarget(), options);
    await assert.rejects(f.run(), new RegExp(code));
    assert.equal(f.writes.length, 0);
    assert.equal(f.payloads.size, 0);
  });
