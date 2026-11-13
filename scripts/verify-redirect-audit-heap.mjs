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

const linkCount = 100;
const pageBody = '<html><body>' +
  Array.from({ length: linkCount }, (_, i) => `<a href="/products/missing-${i}">Product</a>`).join("") +
  '<i> </i>'.repeat(245_000) + '</body></html>';
assert.ok(Buffer.byteLength(pageBody) < 2 * 1024 * 1024);
const heavyResult = await runRedirectAudit({
  primaryDomain: origin,
  maxSourcePages: 1,
  fetchDocument: async ({ url }) => {
    const path = new URL(url).pathname;
    const isSitemap = path === "/sitemap.xml";
    const isPage = path === "/products/source";
    const missing = /^\/products\/missing-\d+$/.test(path);
    assert.ok(isSitemap || isPage || missing, url);
    return {
      requestedUrl: url,
      finalUrl: url,
      statusCode: missing ? 404 : 200,
      html: isSitemap
        ? `<urlset><url><loc>${origin}/products/source</loc></url></urlset>`
        : isPage
          ? pageBody
          : Buffer.alloc(2 * 1024 * 1024 - 64, "x").toString() + path,
      redirectChain: [],
      loopDetected: false,
      contentType: isSitemap ? "application/xml" : "text/html",
      error: null,
    };
  },
});
assert.equal(heavyResult.sourcePagesSucceeded, 1);
assert.equal(heavyResult.brokenInternalLinks.length, linkCount);
assert.ok(heavyResult.brokenInternalLinks.every(({ statusCode }) => statusCode === 404));
console.log(`REDIRECT_AUDIT_HEAP_LINKS_PASS links=${linkCount}`);
