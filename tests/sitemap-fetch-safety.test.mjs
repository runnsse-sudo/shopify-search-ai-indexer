import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
// Compile the actual sitemap adapter into the existing ignored test output directory.
mkdirSync(new URL("../build-tests/", import.meta.url), { recursive: true });
await build({
  entryPoints: ["app/services/sitemap/sitemap-audit.server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "build-tests/sitemap-fetch-safety.mjs",
});
const { defaultXmlFetcher } =
  await import("../build-tests/sitemap-fetch-safety.mjs");
const input = {
  url: "https://store.myshopify.com/sitemap.xml",
  allowedHost: "store.myshopify.com",
};
const resolve = async () => [{ address: "93.184.216.34" }];

test("actual sitemap XML adapter accepts ordinary public Shopify host", async () => {
  const result = await defaultXmlFetcher(input, {
    resolve,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return new Response("<urlset/>", {
        headers: { "content-type": "application/xml" },
      });
    },
  });
  assert.equal(result.body, "<urlset/>");
  assert.equal(result.statusCode, 200);
});
test("actual sitemap XML adapter rejects ports/private DNS without network", async () => {
  const attempts = [];
  const fetchImpl = async (url) => {
    attempts.push(url.href);
    return new Response("<urlset/>");
  };
  await assert.rejects(
    defaultXmlFetcher(
      { ...input, url: "https://store.myshopify.com:8443/sitemap.xml" },
      { resolve, fetchImpl },
    ),
    /PORT_NOT_ALLOWED/,
  );
  await assert.rejects(
    defaultXmlFetcher(input, {
      resolve: async () => [{ address: "169.254.169.254" }],
      fetchImpl,
    }),
    /NON_PUBLIC_DESTINATION/,
  );
  assert.deepEqual(attempts, []);
});
test("actual sitemap adapter preserves20MiB XML cap and cancels chunked overflow", async () => {
  let reads = 0,
    cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    defaultXmlFetcher(input, {
      resolve,
      fetchImpl: async () =>
        new Response(body, { headers: { "content-length": "1" } }),
    }),
    /BODY_TOO_LARGE/,
  );
  assert.equal(reads, 3);
  assert.equal(cancelled, true);
});
