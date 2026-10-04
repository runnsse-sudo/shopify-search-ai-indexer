import assert from "node:assert/strict";

import {
  extractInternalLinks,
  normalizeInternalUrl,
  normalizeSitemapDocumentUrl,
  suggestRedirect,
} from "../build-tests/redirect-audit.mjs";

import {
  runRedirectAudit,
} from "../build-tests/redirect-audit-server.mjs";

assert.equal(
  normalizeInternalUrl(
    "/products/widget/#details",
    "https://example.com/pages/home",
    "example.com",
  ),
  "https://example.com/products/widget",
);

assert.equal(
  normalizeInternalUrl(
    "https://example.com/products/widget?variant=123#reviews",
    "https://example.com/pages/home",
    "example.com",
  ),
  "https://example.com/products/widget",
);

assert.equal(
  normalizeSitemapDocumentUrl(
    "https://example.com/sitemap_products_1.xml?from=100&to=200#fragment",
    "https://example.com/sitemap.xml",
    "example.com",
  ),
  "https://example.com/sitemap_products_1.xml?from=100&to=200",
);

assert.equal(
  normalizeInternalUrl(
    "https://evil.example/products/widget",
    "https://example.com/pages/home",
    "example.com",
  ),
  null,
);

const extracted =
  extractInternalLinks(
    `<!doctype html>
<html>
<body>
<a href="/products/widget">Widget</a>
<a href="/products/widget?variant=123#reviews">Duplicate</a>
<a href="https://example.com/collections/good/">Collection</a>
<a href="https://evil.example/nope">External</a>
<a href="mailto:test@example.com">Mail</a>
</body>
</html>`,
    "https://example.com/pages/home",
    "example.com",
  );

assert.deepEqual(
  extracted,
  [
    "https://example.com/products/widget",
    "https://example.com/collections/good",
  ],
);

const crossLocaleSuggestion =
  suggestRedirect(
    "https://example.com/products/widget",
    [
      "https://example.com/en/products/widget",
      "https://example.com/en-en/products/widget",
    ],
  );

assert.equal(
  crossLocaleSuggestion,
  null,
);

const highSuggestion =
  suggestRedirect(
    "https://example.com/en/blogs/old-blog/widget",
    [
      "https://example.com/en/blogs/new-blog/widget",
      "https://example.com/sv/blogs/new-blog/widget",
    ],
  );

assert.equal(
  highSuggestion?.confidence,
  "HIGH",
);

assert.equal(
  highSuggestion?.targetUrl,
  "https://example.com/en/blogs/new-blog/widget",
);

const mediumSuggestion =
  suggestRedirect(
    "https://example.com/products/widget-old",
    [
      "https://example.com/products/widget",
      "https://example.com/pages/contact",
    ],
  );

assert.equal(
  mediumSuggestion?.confidence,
  "MEDIUM",
);

console.log(
  "REDIRECT_AUDIT_SITEMAP_QUERY_PASS",
);

console.log(
  "REDIRECT_AUDIT_CORE_PASS",
);

const rootXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap_content_1.xml?from=1&amp;to=3</loc>
  </sitemap>
</sitemapindex>`;

const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/pages/home</loc>
  </url>
  <url>
    <loc>https://example.com/products/widget</loc>
  </url>
  <url>
    <loc>https://example.com/collections/good</loc>
  </url>
</urlset>`;

const fetchDocument =
  async ({
    url,
    preserveSearch,
  }) => {
    if (
      url ===
      "https://example.com/sitemap.xml"
    ) {
      assert.equal(
        preserveSearch,
        true,
      );

      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 200,
        html: rootXml,
        redirectChain: [],
        loopDetected: false,
        contentType:
          "application/xml",
        error: null,
      };
    }

    if (
      url ===
      "https://example.com/sitemap_content_1.xml?from=1&to=3"
    ) {
      assert.equal(
        preserveSearch,
        true,
      );

      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 200,
        html: contentXml,
        redirectChain: [],
        loopDetected: false,
        contentType:
          "application/xml",
        error: null,
      };
    }

    if (
      url ===
      "https://example.com/pages/home"
    ) {
      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 200,
        html: `<!doctype html>
<html>
<body>
<a href="/products/widget-old">Broken</a>
<a href="/old-widget">Redirect</a>
<a href="/loop-a">Loop</a>
<a href="/gone">Gone</a>
<a href="/too-large">Too large</a>
<a href="/collections/good">Good</a>
<a href="https://outside.example/nope">External</a>
</body>
</html>`,
        redirectChain: [],
        loopDetected: false,
        contentType:
          "text/html",
        error: null,
      };
    }

    if (
      url ===
      "https://example.com/products/widget"
    ) {
      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 200,
        html:
          "<html><body><h1>Widget</h1></body></html>",
        redirectChain: [],
        loopDetected: false,
        contentType:
          "text/html",
        error: null,
      };
    }

    if (
      url ===
      "https://example.com/collections/good"
    ) {
      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 200,
        html:
          "<html><body><h1>Good</h1></body></html>",
        redirectChain: [],
        loopDetected: false,
        contentType:
          "text/html",
        error: null,
      };
    }

    if (
      url ===
      "https://example.com/products/widget-old"
    ) {
      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 404,
        html:
          "<html><body><h1>Missing</h1></body></html>",
        redirectChain: [],
        loopDetected: false,
        contentType:
          "text/html",
        error: null,
      };
    }

    if (
      url ===
      "https://example.com/old-widget"
    ) {
      return {
        requestedUrl: url,
        finalUrl:
          "https://example.com/products/widget",
        statusCode: 200,
        html:
          "<html><body><h1>Widget</h1></body></html>",
        redirectChain: [
          "https://example.com/products/widget",
        ],
        loopDetected: false,
        contentType:
          "text/html",
        error: null,
      };
    }

    if (
      url ===
      "https://example.com/loop-a"
    ) {
      return {
        requestedUrl: url,
        finalUrl:
          "https://example.com/loop-a",
        statusCode: 302,
        html: "",
        redirectChain: [
          "https://example.com/loop-b",
          "https://example.com/loop-a",
        ],
        loopDetected: true,
        contentType:
          "text/html",
        error:
          "REDIRECT_LOOP",
      };
    }

    if (
      url ===
      "https://example.com/gone"
    ) {
      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 410,
        html:
          "<html><body><h1>Gone</h1></body></html>",
        redirectChain: [],
        loopDetected: false,
        contentType:
          "text/html",
        error: null,
      };
    }

    if (
      url ===
      "https://example.com/too-large"
    ) {
      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 200,
        html: "",
        redirectChain: [],
        loopDetected: false,
        contentType:
          "text/html",
        error:
          "BODY_TOO_LARGE",
      };
    }

    throw new Error(
      `UNEXPECTED_FETCH:${url}`,
    );
  };

const result =
  await runRedirectAudit({
    primaryDomain:
      "example.com",
    maxSourcePages:
      3,
    maxLinkChecks:
      10,
    fetchDocument,
  });

assert.equal(
  result.sitemapDocumentsFetched,
  2,
);

assert.equal(
  result.sitemapUrls,
  3,
);

assert.equal(
  result.sourcePagesRequested,
  3,
);

assert.equal(
  result.sourcePagesSucceeded,
  3,
);

assert.equal(
  result.internalLinksDiscovered,
  6,
);

assert.equal(
  result.internalLinksChecked,
  6,
);

assert.equal(
  result.notFoundCount,
  1,
);

assert.equal(
  result.redirectCount,
  2,
);

assert.equal(
  result.redirectChainCount,
  1,
);

assert.equal(
  result.redirectLoopCount,
  1,
);

assert.equal(
  result.brokenInternalLinkCount,
  3,
);

const missing =
  result.brokenInternalLinks.find(
    (item) =>
      item.url ===
      "https://example.com/products/widget-old",
  );

assert.equal(
  missing?.statusCode,
  404,
);

assert.equal(
  missing?.suggestion?.targetUrl,
  "https://example.com/products/widget",
);

assert.equal(
  missing?.suggestion?.confidence,
  "MEDIUM",
);

const loop =
  result.brokenInternalLinks.find(
    (item) =>
      item.url ===
      "https://example.com/loop-a",
  );

assert.equal(
  loop?.error,
  "REDIRECT_LOOP",
);

assert.equal(
  loop?.suggestion,
  null,
);

const gone =
  result.brokenInternalLinks.find(
    (item) =>
      item.url ===
      "https://example.com/gone",
  );

assert.equal(
  gone?.statusCode,
  410,
);

assert.equal(
  gone?.suggestion,
  null,
);

assert.equal(
  result.clientErrorCount,
  2,
);

assert.equal(
  result.internalLinksUnverified,
  1,
);

const tooLargeBroken =
  result.brokenInternalLinks.find(
    (item) =>
      item.url ===
      "https://example.com/too-large",
  );

assert.equal(
  tooLargeBroken,
  undefined,
);

assert.equal(
  result.suggestionCounts.MEDIUM,
  1,
);

console.log(
  "REDIRECT_AUDIT_404_DISCOVERY_PASS",
);

console.log(
  "REDIRECT_AUDIT_REDIRECT_DISCOVERY_PASS",
);

console.log(
  "REDIRECT_AUDIT_CHAIN_LOOP_PASS",
);

console.log(
  "REDIRECT_AUDIT_BROKEN_INTERNAL_LINK_PASS",
);

console.log(
  "REDIRECT_AUDIT_SUGGESTION_CONFIDENCE_PASS",
);

console.log(
  "REDIRECT_AUDIT_UNVERIFIED_LINK_PASS",
);

console.log(
  "REDIRECT_AUDIT_VERIFY_PASS",
);