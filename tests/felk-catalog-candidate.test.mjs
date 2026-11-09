import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { catalogPublisher } from "../app/services/llm-visibility/multishop-catalog-publication.server.ts";
import { felkCatalogAddress } from "../app/services/llm-visibility/felk-catalog-address.ts";
import {
  felkCatalogLinkChange,
  restoreFelkCatalogLink,
} from "../app/services/llm-visibility/felk-catalog-candidate.server.ts";
import { robottoCatalogFailure } from "../app/services/llm-visibility/robotto-catalog-diagnostics.ts";

const target = {
  shop: "94d715-94.myshopify.com",
  primaryDomain: "www.felkodslasare.se",
  fileId: "gid://shopify/GenericFile/77579264491788",
  cdnPath: "/s/files/1/0746/4979/6876/files/llms-full.txt",
};
const sha = (x) => createHash("sha256").update(x).digest("hex");
const oldBytes = Buffer.from(
  `# ${target.primaryDomain}\n\n## Products\n- [Old](https://${target.primaryDomain}/products/old)\n`,
);
function fixture(options = {}) {
  let locked = false,
    backups = 0,
    stagedBytes,
    filename,
    reads = 0,
    waits = 0,
    creates = 0,
    stateWrites = 0;
  const calls = [],
    phases = [];
  const id = "gid://shopify/GenericFile/999";
  const storage = {
    shop: target.shop,
    async withLock(fn) {
      if (locked || options.locked)
        throw new Error("CATALOG_PUBLICATION_LOCKED");
      locked = true;
      const result = await fn();
      locked = false;
      return result;
    },
    async readDailyState() {
      return null;
    },
    async saveDailyState() {
      stateWrites++;
    },
    async persistBackup(bytes, digest) {
      assert.ok(locked);
      assert.equal(sha(bytes), digest);
      assert.deepEqual(bytes, oldBytes);
      if (options.backupFailure) throw new Error("PERSISTED_BACKUP_MISMATCH");
      backups++;
      return bytes;
    },
  };
  const admin = {
    async graphql(operation, args) {
      calls.push(operation);
      assert.ok(locked);
      assert.doesNotMatch(operation, /fileUpdate|fileDelete|themeFilesUpsert/);
      if (operation.includes("DailyCatalogCount"))
        return Response.json({
          data: {
            shop: {
              myshopifyDomain: target.shop,
              primaryDomain: { host: target.primaryDomain },
            },
            productsCount: { count: 1, precision: "EXACT" },
          },
        });
      if (operation.includes("PublicLlmCatalog"))
        return Response.json({
          data: {
            products: {
              nodes: [
                {
                  legacyResourceId: "1",
                  title: "New",
                  status: "ACTIVE",
                  onlineStoreUrl: `https://${target.primaryDomain}/products/${options.unchanged ? "old" : "new"}`,
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      if (operation.includes("ReadRobottoCatalog")) {
        const candidate = args.variables.id === id;
        if (candidate) reads++;
        return Response.json({
          data: {
            shop: {
              myshopifyDomain:
                candidate && options.foreignShop
                  ? "other.myshopify.com"
                  : target.shop,
            },
            currentAppInstallation: {
              accessScopes: [
                { handle: options.noScope ? "read_files" : "write_files" },
              ],
            },
            node: {
              id: candidate ? id : target.fileId,
              fileStatus:
                candidate && options.processing ? "PROCESSING" : "READY",
              url: `https://cdn.shopify.com${candidate ? target.cdnPath.replace("llms-full.txt", options.wrongFilename ? "wrong.txt" : filename) : target.cdnPath}?v=${candidate && options.versionDrift && reads > 1 ? 2 : 1}`,
            },
          },
        });
      }
      if (operation.includes("StageRobottoCatalog")) {
        assert.equal(
          backups,
          1,
          "durable backup precedes every staging request",
        );
        filename = args.variables.input[0].filename;
        return Response.json({
          data: {
            stagedUploadsCreate: {
              stagedTargets: [
                {
                  url: options.foreignStage
                    ? "https://attacker.example/upload"
                    : "https://shopify-staged-uploads.storage.googleapis.com/upload",
                  resourceUrl:
                    "https://shopify-staged-uploads.storage.googleapis.com/content",
                  parameters: [],
                },
              ],
              userErrors: [],
            },
          },
        });
      }
      assert.match(operation, /CreateFelkCatalog/);
      creates++;
      assert.equal(args.variables.files.length, 1);
      assert.equal(
        args.variables.files[0].duplicateResolutionMode,
        "RAISE_ERROR",
      );
      assert.equal(
        args.variables.files[0].filename,
        `llms-full-${sha(stagedBytes)}.txt`,
      );
      assert.equal(args.variables.files[0].contentType, "FILE");
      if (options.createTimeout) throw new Error("Timeout");
      return Response.json({
        data: {
          fileCreate: {
            files: options.duplicate ? [] : [{ id }],
            userErrors: options.duplicate
              ? [{ field: ["files", "0", "filename"] }]
              : [],
          },
        },
      });
    },
  };
  const transport = async (value, init) => {
    assert.ok(locked);
    assert.equal(init.redirect, "error");
    const url = new URL(value);
    if (url.hostname === "shopify-staged-uploads.storage.googleapis.com") {
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("file").name, filename);
      stagedBytes = Buffer.from(await init.body.get("file").arrayBuffer());
      return new Response(null, { status: 204 });
    }
    assert.ok(["cdn.shopify.com", target.primaryDomain].includes(url.hostname));
    const candidate = url.pathname.includes("llms-full-");
    if (!candidate)
      return new Response(
        options.baselineMismatch && url.hostname === target.primaryDomain
          ? "different old bytes"
          : oldBytes,
      );
    if (options.oversize)
      return new Response(Buffer.alloc(stagedBytes.length + 1));
    if (
      url.hostname === target.primaryDomain &&
      (options.stale || (options.transient && waits === 0))
    )
      return new Response("stale");
    return new Response(stagedBytes);
  };
  return {
    calls,
    phases,
    run: () =>
      catalogPublisher(
        target,
        (phase) => phases.push(phase),
        "felk-sha-candidate",
      ).refresh(
        storage,
        target.shop,
        admin,
        transport,
        () => 100000000,
        async () => {
          waits++;
        },
      ),
    info: () => ({ locked, backups, creates, stateWrites, waits, stagedBytes }),
  };
}

test("locked full candidate flow backs up old content and returns exact new URL without checkpoint or link write", async () => {
  const f = fixture();
  const result = await f.run();
  const s = f.info();
  assert.equal(result.status, "CANDIDATE_READY");
  assert.equal(result.sha256, sha(s.stagedBytes));
  assert.equal(result.filename, `llms-full-${result.sha256}.txt`);
  assert.equal(s.creates, 1);
  assert.equal(s.backups, 1);
  assert.equal(s.locked, false);
  assert.equal(s.stateWrites, 0);
  assert.ok(f.phases.indexOf("backup") < f.phases.indexOf("file_create"));
  assert.ok(result.linkChangeRequired);
});
test("unchanged product links skip new file and backup", async () => {
  const f = fixture({ unchanged: true });
  assert.equal((await f.run()).status, "UNCHANGED");
  assert.equal(f.info().creates, 0);
  assert.equal(f.info().backups, 0);
});
for (const [option, code] of [
  ["locked", "CATALOG_PUBLICATION_LOCKED"],
  ["backupFailure", "PERSISTED_BACKUP_MISMATCH"],
  ["baselineMismatch", "PUBLIC_CDN_HASH_MISMATCH"],
  ["noScope", "WRITE_FILES_NOT_GRANTED"],
  ["foreignStage", "STAGING_TARGET_MISMATCH"],
  ["duplicate", "FILE_CREATE_REJECTED"],
  ["createTimeout", "Timeout"],
  ["stale", "PUBLIC_HASH_NOT_VERIFIED"],
  ["processing", "PUBLIC_HASH_NOT_VERIFIED"],
  ["wrongFilename", "CONTENT_ADDRESS_METADATA_MISMATCH"],
  ["foreignShop", "SHOP_OR_FILE_MISMATCH"],
  ["versionDrift", "PUBLIC_FILE_VERSION_DRIFT"],
  ["oversize", "PUBLIC_FILE_TOO_LARGE"],
])
  test(`${option} fails closed, preserves lock and never retries creation`, async () => {
    const f = fixture({ [option]: true });
    await assert.rejects(f.run(), new RegExp(code));
    assert.ok(f.info().creates <= 1);
    assert.equal(f.info().stateWrites, 0);
    if (option !== "locked") assert.equal(f.info().locked, true);
  });
test("bounded transient CDN delay succeeds without recreating file", async () => {
  const f = fixture({ transient: true });
  assert.equal((await f.run()).status, "CANDIDATE_READY");
  assert.equal(f.info().waits, 1);
  assert.equal(f.info().creates, 1);
});
test("candidate path rejects wrong shop and altered legacy identity before I/O", () => {
  for (const changed of [
    { shop: "robotto-7143.myshopify.com" },
    { fileId: "gid://shopify/GenericFile/100" },
    { primaryDomain: "other.example" },
  ])
    assert.throws(
      () =>
        catalogPublisher(
          { ...target, ...changed },
          undefined,
          "felk-sha-candidate",
        ),
      /INVALID_CATALOG_TARGET/,
    );
});
const oldUrl =
  "https://www.felkodslasare.se/cdn/shop/files/llms-full.txt?v=123";
function linkInput() {
  const candidate = oldBytes;
  const plan = felkCatalogAddress(target.shop, candidate);
  const template = `<a href="${oldUrl}">Catalog</a>\r\n`;
  return {
    template,
    expectedSha256: sha(template),
    previousUrl: oldUrl,
    candidate,
    metadata: {
      shop: target.shop,
      id: "gid://shopify/GenericFile/999",
      status: "READY",
      url: `https://cdn.shopify.com${plan.canonicalPath}?v=2`,
    },
  };
}
test("exact template patch includes untouched rollback and SHA preconditions", () => {
  const input = linkInput();
  const patch = felkCatalogLinkChange(input);
  assert.equal(patch.before, input.template);
  assert.equal(patch.rollback.restore, input.template);
  assert.equal(patch.rollback.expectedCurrentSha256, sha(patch.after));
  assert.equal(patch.after, input.template.replace(oldUrl, patch.nextUrl));
  assert.equal(patch.filename, "templates/llms-full.txt.liquid");
  assert.equal(patch.status, "REVIEW_ONLY");
  assert.equal(patch.requiresSeparateThemeAuthorization, true);
});
test("template drift, ambiguous replacements, absent link and foreign URL cannot produce patches", () => {
  const input = linkInput();
  assert.throws(
    () => felkCatalogLinkChange({ ...input, expectedSha256: "0".repeat(64) }),
    /TEMPLATE_DRIFT/,
  );
  for (const template of ["no link", input.template + oldUrl])
    assert.throws(
      () =>
        felkCatalogLinkChange({
          ...input,
          template,
          expectedSha256: sha(template),
        }),
      /AMBIGUOUS/,
    );
  assert.throws(
    () =>
      felkCatalogLinkChange({ ...input, previousUrl: "https://evil.example/" }),
    /URL_MISMATCH/,
  );
});
test("rollback restores exact bytes and rejects any intervening edit", () => {
  const patch = felkCatalogLinkChange(linkInput());
  assert.equal(restoreFelkCatalogLink(patch.after, patch), patch.before);
  assert.throws(
    () => restoreFelkCatalogLink(patch.after + "<!-- merchant edit -->", patch),
    /TEMPLATE_DRIFT/,
  );
  assert.throws(
    () =>
      restoreFelkCatalogLink(patch.after, {
        ...patch,
        beforeSha256: "0".repeat(64),
      }),
    /TEMPLATE_DRIFT/,
  );
});
test("per-side hashes survive a failed candidate verification without response bodies", async () => {
  const f = fixture({ stale: true });
  try {
    await f.run();
    assert.fail("must fail");
  } catch (error) {
    const report = robottoCatalogFailure(error, "public_verify");
    assert.equal(report.code, "PUBLIC_HASH_NOT_VERIFIED");
    assert.equal(
      report.verification.canonicalSha256,
      sha(f.info().stagedBytes),
    );
    assert.equal(report.verification.downloadSha256, sha("stale"));
    assert.ok(!JSON.stringify(report).includes("https://"));
  }
});
test("new safe failure codes survive diagnostics without provider details", () => {
  const e = Object.assign(new Error("FILE_CREATE_REJECTED"), {
    token: "SECRET",
  });
  const result = robottoCatalogFailure(e, "file_create");
  assert.equal(result.code, "FILE_CREATE_REJECTED");
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});
