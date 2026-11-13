import assert from "node:assert/strict";
import { runRedirectAudit } from "../build-tests/redirect-audit-server.mjs";

const origin = "https://example.com";
const count = 50_000;
const images = '<image:image><image:loc>https://cdn.example/p</image:loc></image:image>'.repeat(4);
const sitemap = '<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">' +
  Array.from({ length: count }, (_, index) =>
    `<url><loc>${origin}/products/widget-${index}</loc><lastmod>2026-11-13</lastmod>${images}</url>\n`,
  ).join("") +
  "</urlset>";

assert.ok(Buffer.byteLength(sitemap) < 20 * 1024 * 1024);
const result = await runRedirectAudit({
  primaryDomain: origin,
  maxSourcePages: 1,
  fetchDocument: async ({ url }) => {
    assert.ok(url === `${origin}/sitemap.xml` || url === `${origin}/products/widget-0`, url);
    return {
      requestedUrl: url,
      finalUrl: url,
      statusCode: 200,
      html: url.endsWith(".xml") ? sitemap : "<html></html>",
      redirectChain: [],
      loopDetected: false,
      contentType: url.endsWith(".xml") ? "application/xml" : "text/html",
      error: null,
    };
  },
});
assert.equal(result.sitemapUrls, count);
assert.equal(result.coverage.sitemapUrlsTruncated, false);
assert.equal(result.coverage.sitemapDocumentsTruncated, false);
console.log(`REDIRECT_AUDIT_HEAP_PASS urls=${count} bytes=${Buffer.byteLength(sitemap)}`);
