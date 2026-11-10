import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  refreshFelkAutomaticCatalog,
  parseFelkHandoverConfig,
} from "../app/services/llm-visibility/felk-catalog-handover.server.ts";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const shop = "94d715-94.myshopify.com",
  domain = "www.felkodslasare.se";
const config = {
  enabled: true,
  shop,
  ownerId: "gid://shopify/Shop/1",
  namespace: "app--123",
};
const text = (handle) =>
  Buffer.from(
    `# ${domain}\n\n## Products\n- [Product](https://${domain}/products/${handle})\n`,
  );
function fixture(options = {}) {
  const oldBytes = text("old"),
    oldSha = sha(oldBytes);
  const target = {
    shop,
    primaryDomain: domain,
    fileId: "gid://shopify/GenericFile/2",
    cdnPath: `/s/files/1/0746/4979/6876/files/llms-full-${oldSha}.txt`,
    contentSha256: oldSha,
  };
  const pointerFor = (id, bytes, version) => ({
    schema: "FELK_CATALOG_POINTER_V1",
    shop,
    fileId: id,
    sha256: sha(bytes),
    canonical: `https://cdn.shopify.com/s/files/1/0746/4979/6876/files/llms-full-${sha(bytes)}.txt?v=${version}`,
    download: `https://${domain}/cdn/shop/files/llms-full-${sha(bytes)}.txt?v=${version}`,
  });
  const oldPointer = pointerFor(target.fileId, oldBytes, 1);
  let pointer = oldPointer,
    compareDigest = "a".repeat(64),
    value = JSON.stringify(pointer);
  let staged,
    locked = false,
    state = options.state ?? null,
    pointerWrites = 0,
    creations = 0,
    waits = 0;
  const backups = new Map(),
    files = new Map([[target.fileId, { pointer, bytes: oldBytes }]]),
    calls = [];
  const storage = {
    shop,
    async withLock(run) {
      if (locked || options.locked)
        throw new Error("CATALOG_PUBLICATION_LOCKED");
      locked = true;
      const x = await run();
      locked = false;
      return x;
    },
    async readDailyState() {
      assert.ok(locked);
      return state;
    },
    async saveDailyState(x) {
      assert.ok(locked);
      if (options.stateFailure) throw new Error("CATALOG_STATE_UNVERIFIED");
      state = x;
    },
    async persistBackup(bytes, digest) {
      assert.ok(locked);
      assert.equal(sha(bytes), digest);
      if (options.backupFailure) return Buffer.from("bad");
      backups.set(digest, Buffer.from(bytes));
      return Buffer.from(bytes);
    },
  };
  const metadata = () => ({
    namespace: config.namespace,
    key: "felk_catalog_pointer",
    type: "json",
    value: options.invalidPointer
      ? JSON.stringify({ ...pointer, download: "https://evil.example/" })
      : value,
    compareDigest,
    definition: {
      ownerType: "SHOP",
      namespace: config.namespace,
      key: "felk_catalog_pointer",
      type: { name: "json" },
      access: {
        admin: options.merchantWrite ? "MERCHANT_READ_WRITE" : "MERCHANT_READ",
        storefront: options.private ? "NONE" : "PUBLIC_READ",
      },
    },
  });
  const admin = {
    async graphql(query, args) {
      calls.push(query);
      if (query.includes("ReadFelkPointer"))
        return Response.json({
          data: {
            shop: {
              id: options.foreignOwner
                ? "gid://shopify/Shop/9"
                : config.ownerId,
              myshopifyDomain: options.foreignShop ?? shop,
              primaryDomain: { host: domain },
              metafield: options.missing ? null : metadata(),
            },
            currentAppInstallation: {
              app: {
                id: options.foreignApp
                  ? "gid://shopify/App/9"
                  : "gid://shopify/App/123",
              },
            },
          },
        });
      if (query.includes("SetFelkPointer")) {
        assert.ok(locked);
        const write = args.variables.metafields[0];
        assert.ok(Object.hasOwn(write, "compareDigest"));
        assert.equal(write.ownerId, config.ownerId);
        if (
          (options.casConflict && pointerWrites === 0) ||
          (options.rollbackConflict && pointerWrites === 1)
        )
          return Response.json({
            data: {
              metafieldsSet: {
                metafields: [],
                userErrors: [{ code: "INVALID_COMPARE_DIGEST" }],
              },
            },
          });
        if (options.uncertainWrite) throw new Error("provider secret");
        assert.equal(write.compareDigest, compareDigest);
        pointerWrites++;
        value = write.value;
        pointer = JSON.parse(value);
        compareDigest = String(pointerWrites).repeat(64);
        return Response.json({
          data: { metafieldsSet: { metafields: [metadata()], userErrors: [] } },
        });
      }
      if (query.includes("DailyCatalogCount"))
        return Response.json({
          data: {
            shop: { myshopifyDomain: shop, primaryDomain: { host: domain } },
            productsCount: {
              count: options.incomplete ? 2 : 1,
              precision: "EXACT",
            },
          },
        });
      if (query.includes("PublicLlmCatalog"))
        return Response.json({
          data: {
            products: {
              nodes: [
                {
                  legacyResourceId: "1",
                  title: "Product",
                  status: "ACTIVE",
                  onlineStoreUrl: `https://${domain}/products/${options.unchanged ? "old" : "new"}`,
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      if (query.includes("ReadRobottoCatalog")) {
        const file = files.get(args.variables.id);
        return Response.json({
          data: {
            shop: { myshopifyDomain: shop },
            currentAppInstallation: {
              accessScopes: options.noScope ? [] : [{ handle: "write_files" }],
            },
            node: {
              id: args.variables.id,
              fileStatus: "READY",
              url: file.pointer.canonical,
            },
          },
        });
      }
      if (query.includes("stagedUploadsCreate"))
        return Response.json({
          data: {
            stagedUploadsCreate: {
              stagedTargets: [
                {
                  url: "https://shopify-staged-uploads.storage.googleapis.com/upload",
                  resourceUrl:
                    "https://shopify-staged-uploads.storage.googleapis.com/resource",
                  parameters: [],
                },
              ],
              userErrors: [],
            },
          },
        });
      if (query.includes("CreateFelkCatalog")) {
        assert.ok(locked);
        assert.ok(backups.size >= 2);
        assert.equal(
          args.variables.files[0].duplicateResolutionMode,
          "RAISE_ERROR",
        );
        creations++;
        const id = "gid://shopify/GenericFile/3";
        const next = pointerFor(id, staged, 2);
        files.set(id, { pointer: next, bytes: staged });
        return Response.json({
          data: { fileCreate: { files: [{ id }], userErrors: [] } },
        });
      }
      throw new Error("Unexpected operation");
    },
  };
  const transport = async (url, init) => {
    assert.equal(init.redirect, "error");
    if (
      url === "https://shopify-staged-uploads.storage.googleapis.com/upload"
    ) {
      assert.ok(locked);
      staged = Buffer.from(await init.body.get("file").arrayBuffer());
      return new Response(null, { status: 204 });
    }
    if (url === `https://${domain}/llms-full.txt`) {
      const publicPointer =
        options.oldDiscovery ||
        (options.discoveryDelay && waits < 2 && pointerWrites === 1)
          ? oldPointer
          : pointer;
      return new Response(`- [Download](${publicPointer.download})\n`);
    }
    for (const { pointer: p, bytes } of files.values())
      if ([p.canonical, p.download].includes(url))
        return new Response(
          options.badNewHash && p.fileId.endsWith("/3") ? "bad" : bytes,
        );
    throw new Error("Unexpected URL");
  };
  return {
    run: (extra = {}) =>
      refreshFelkAutomaticCatalog({
        target,
        config,
        storage,
        admin: async () => admin,
        transport,
        wait: async () => {
          waits++;
        },
        now: () => 1794343187265,
        ...extra,
      }),
    snapshot: () => ({
      pointer,
      value: options.invalidPointer
        ? JSON.stringify({ ...pointer, download: "https://evil.example/" })
        : value,
      compareDigest,
      pointerWrites,
      creations,
      state,
      locked,
      backups,
      waits,
      calls,
    }),
    oldPointer,
    target,
  };
}

test("handover remains disabled without explicit configuration", () => {
  assert.equal(parseFelkHandoverConfig(), null);
  for (const x of [
    "null",
    "{}",
    "false",
    JSON.stringify({ ...config, enabled: false }),
    JSON.stringify({ ...config, namespace: "custom" }),
    JSON.stringify({ ...config, shop: "robotto-7143.myshopify.com" }),
    JSON.stringify({ ...config, extra: true }),
  ])
    assert.throws(() => parseFelkHandoverConfig(x));
});
test("changed catalog completes one immutable creation, CAS, verification and new target checkpoint", async () => {
  const f = fixture();
  const r = await f.run();
  const s = f.snapshot();
  assert.equal(r.status, "PUBLISHED");
  assert.equal(s.creations, 1);
  assert.equal(s.pointerWrites, 1);
  assert.notEqual(s.pointer.sha256, f.oldPointer.sha256);
  assert.equal(s.state.sha256, s.pointer.sha256);
  assert.equal(
    s.state.targetSha256,
    sha(
      Buffer.from(
        JSON.stringify({
          ...f.target,
          fileId: s.pointer.fileId,
          cdnPath: new URL(s.pointer.canonical).pathname,
          contentSha256: s.pointer.sha256,
        }),
      ),
    ),
  );
  assert.equal(s.locked, false);
});
test("unchanged links never create a file or update the pointer", async () => {
  const f = fixture({ unchanged: true });
  assert.equal((await f.run()).status, "UNCHANGED");
  assert.equal(f.snapshot().creations, 0);
  assert.equal(f.snapshot().pointerWrites, 0);
});
for (const [name, option, code] of [
  ["wrong shop", "foreignShop", "CATALOG_TENANT_MISMATCH"],
  ["wrong owner", "foreignOwner", "CATALOG_TENANT_MISMATCH"],
  ["wrong app namespace owner", "foreignApp", "CATALOG_TENANT_MISMATCH"],
  ["missing pointer", "missing", "CATALOG_POINTER_NOT_QUALIFIED"],
  [
    "merchant editable definition",
    "merchantWrite",
    "CATALOG_POINTER_NOT_QUALIFIED",
  ],
  ["nonpublic definition", "private", "CATALOG_POINTER_NOT_QUALIFIED"],
  ["missing write_files", "noScope", "WRITE_FILES_NOT_GRANTED"],
  ["incomplete catalog", "incomplete", "CATALOG_INCOMPLETE"],
  ["corrupt durable backup", "backupFailure", "PERSISTED_BACKUP_MISMATCH"],
  ["lock contention", "locked", "CATALOG_PUBLICATION_LOCKED"],
])
  test(name + " stops before creation/pointer mutation", async () => {
    const f = fixture({
      [option]: option === "foreignShop" ? "evil.myshopify.com" : true,
    });
    await assert.rejects(f.run(), new RegExp(code));
    assert.equal(f.snapshot().creations, 0);
    assert.equal(f.snapshot().pointerWrites, 0);
  });
test("CAS collision preserves old pointer and checkpoint, keeps uncertain lock", async () => {
  const f = fixture({ casConflict: true });
  await assert.rejects(f.run(), /CATALOG_POINTER_WRITE_UNCONFIRMED/);
  assert.deepEqual(f.snapshot().pointer, f.oldPointer);
  assert.equal(f.snapshot().state, null);
  assert.equal(f.snapshot().locked, true);
});
test("uncertain mutation response never triggers blind rollback or retry", async () => {
  const f = fixture({ uncertainWrite: true });
  await assert.rejects(f.run(), /provider secret/);
  assert.equal(
    f.snapshot().calls.filter((x) => x.includes("SetFelkPointer")).length,
    1,
  );
  assert.equal(f.snapshot().state, null);
});
test("delayed discovery is verified with bounded read waits", async () => {
  const f = fixture({ discoveryDelay: true });
  assert.equal((await f.run()).status, "PUBLISHED");
  assert.equal(f.snapshot().waits, 2);
});
test("failed discovery rolls back only its own CAS-written pointer, keeps checkpoint unchanged", async () => {
  const f = fixture({ oldDiscovery: true });
  await assert.rejects(f.run(), /CATALOG_LINK_ROLLED_BACK/);
  assert.deepEqual(f.snapshot().pointer, f.oldPointer);
  assert.equal(f.snapshot().pointerWrites, 2);
  assert.equal(f.snapshot().state, null);
  assert.equal(f.snapshot().locked, true);
});
test("rollback conflict never overwrites a later pointer and does not retry", async () => {
  const f = fixture({ oldDiscovery: true, rollbackConflict: true });
  await assert.rejects(f.run(), /CATALOG_POINTER_WRITE_UNCONFIRMED/);
  assert.equal(f.snapshot().pointerWrites, 1);
  assert.equal(
    f.snapshot().calls.filter((x) => x.includes("SetFelkPointer")).length,
    2,
  );
  assert.equal(f.snapshot().state, null);
});
test("bad candidate readback cannot change the public pointer", async () => {
  const f = fixture({ badNewHash: true });
  await assert.rejects(f.run(), /PUBLIC_HASH_NOT_VERIFIED/);
  assert.equal(f.snapshot().pointerWrites, 0);
});
test("checkpoint write failure preserves lock and never reports successful completion", async () => {
  const f = fixture({ stateFailure: true });
  await assert.rejects(f.run(), /CATALOG_STATE_UNVERIFIED/);
  assert.equal(f.snapshot().locked, true);
});
test("same-day repeat never publishes twice", async () => {
  const f = fixture({ unchanged: true });
  await f.run();
  assert.equal((await f.run()).status, "NOT_DUE");
  assert.equal(f.snapshot().creations, 0);
});
test("second UTC day follows persisted new pointer instead of stale bootstrap target", async () => {
  const f = fixture();
  await f.run();
  assert.equal(
    (await f.run({ now: () => 1794343187265 + 86400000 })).status,
    "UNCHANGED",
  );
  assert.equal(f.snapshot().creations, 1);
});
test("old-target checkpoint mismatch remains fail closed", async () => {
  const f = fixture({
    state: {
      completedAt: 1794256787265,
      sha256: "a".repeat(64),
      targetSha256: "b".repeat(64),
    },
  });
  await assert.rejects(f.run(), /CATALOG_STATE_TARGET_DRIFT/);
  assert.equal(f.snapshot().creations, 0);
});

test("template preparation uses explicit app namespace and retained verified fallback", async () => {
  const { felkCatalogDiscoveryTemplate } =
    await import("../app/services/llm-visibility/felk-catalog-handover.server.ts");
  const f = fixture();
  const template = felkCatalogDiscoveryTemplate(
    config,
    JSON.stringify(f.oldPointer),
  );
  assert.ok(
    template.includes("shop.metafields['app--123'].felk_catalog_pointer.value"),
  );
  assert.ok(template.includes(f.oldPointer.download));
  assert.ok(template.includes("{{ catalog_pointer.download }}"));
  assert.throws(() =>
    felkCatalogDiscoveryTemplate(
      { ...config, namespace: "merchant" },
      JSON.stringify(f.oldPointer),
    ),
  );
  assert.throws(() =>
    felkCatalogDiscoveryTemplate(
      config,
      JSON.stringify({ ...f.oldPointer, download: "https://evil.example/" }),
    ),
  );
});

test("invalid pointer URL is rejected before creation", async () => {
  const f = fixture({ invalidPointer: true });
  await assert.rejects(f.run(), /CATALOG_POINTER_DRIFT/);
  assert.equal(f.snapshot().creations, 0);
  assert.equal(f.snapshot().pointerWrites, 0);
});
test("handover diagnostics preserve safe new codes without provider details", async () => {
  const { robottoCatalogFailure } =
    await import("../app/services/llm-visibility/robotto-catalog-diagnostics.ts");
  for (const code of [
    "CATALOG_HANDOVER_NOT_ENABLED",
    "CATALOG_POINTER_DRIFT",
    "CATALOG_POINTER_NOT_QUALIFIED",
    "CATALOG_POINTER_WRITE_UNCONFIRMED",
    "CATALOG_LINK_ROLLED_BACK",
  ])
    assert.equal(
      robottoCatalogFailure(new Error(code), "public_verify").code,
      code,
    );
  assert.ok(
    !JSON.stringify(
      robottoCatalogFailure(
        new Error("secret provider token"),
        "public_verify",
      ),
    ).includes("secret"),
  );
});
test("successful transaction has one create and one pointer write, never fileUpdate/delete or theme API", async () => {
  const f = fixture();
  await f.run();
  const s = f.snapshot();
  assert.equal(
    s.calls.filter((x) => x.includes("CreateFelkCatalog")).length,
    1,
  );
  assert.equal(s.calls.filter((x) => x.includes("SetFelkPointer")).length, 1);
  assert.ok(
    !s.calls.some((x) =>
      /fileUpdate|fileDelete|themeFiles|metafieldDefinitionCreate/.test(x),
    ),
  );
});

test("bootstrap is an absent-only local proposal from dual SHA proof", async () => {
  const { prepareFelkPointerBootstrap } =
    await import("../app/services/llm-visibility/felk-catalog-handover.server.ts");
  const f = fixture(),
    bytes = text("old");
  const metadata = {
    shop,
    id: f.target.fileId,
    status: "READY",
    url: f.oldPointer.canonical,
  };
  const proof = {
    sessionShop: shop,
    candidate: bytes,
    before: metadata,
    after: metadata,
    canonical: bytes,
    download: bytes,
  };
  const plan = prepareFelkPointerBootstrap(config, proof);
  assert.equal(plan.requiresSeparateSetupApproval, true);
  assert.equal(plan.variables.metafields[0].compareDigest, null);
  assert.equal(plan.variables.metafields[0].ownerId, config.ownerId);
  assert.equal(f.snapshot().calls.length, 0);
  assert.throws(() =>
    prepareFelkPointerBootstrap(config, {
      ...proof,
      download: Buffer.from("corrupt"),
    }),
  );
});
