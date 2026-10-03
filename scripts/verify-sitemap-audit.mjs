import assert from "node:assert/strict";

import {
  classifySitemapUrl,
  normalizeComparableUrl,
  parseSitemapXml,
} from "../build-tests/sitemap-audit.mjs";

import {
  runSitemapAudit,
} from "../build-tests/sitemap-audit-server.mjs";

const rootXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap_products_1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap_content_1.xml</loc>
  </sitemap>
</sitemapindex>`;

const productXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
>
  <url>
    <loc>https://example.com/products/test-product</loc>
    <lastmod>2026-10-01T00:00:00Z</lastmod>
    <image:image>
      <image:loc>https://cdn.example.net/test-product-1.jpg</image:loc>
    </image:image>
    <image:image>
      <image:loc>https://cdn.example.net/test-product-2.jpg</image:loc>
    </image:image>
  </url>
  <url>
    <loc>https://example.com/collections/test</loc>
  </url>
</urlset>`;

const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/pages/about</loc>
  </url>
  <url>
    <loc>https://example.com/blogs/news</loc>
  </url>
  <url>
    <loc>https://example.com/blogs/news/article-one</loc>
  </url>
</urlset>`;

const parsedRoot =
  parseSitemapXml(
    rootXml,
    "https://example.com/sitemap.xml",
  );

assert.equal(
  parsedRoot.kind,
  "INDEX",
);

assert.equal(
  parsedRoot.sitemaps.length,
  2,
);

const parsedProduct =
  parseSitemapXml(
    productXml,
    "https://example.com/sitemap_products_1.xml",
  );

assert.equal(
  parsedProduct.kind,
  "URLSET",
);

assert.equal(
  parsedProduct.urls.length,
  2,
);

assert.equal(
  parsedProduct.urls[0].images.length,
  2,
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/products/test",
  ),
  "PRODUCT",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/collections/test",
  ),
  "COLLECTION",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/pages/about",
  ),
  "PAGE",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/blogs/news",
  ),
  "BLOG",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/blogs/news/article",
  ),
  "ARTICLE",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/en-en/products/test",
  ),
  "PRODUCT",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/sv-se/collections/test",
  ),
  "COLLECTION",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/en/pages/about",
  ),
  "PAGE",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/en-en/blogs/news",
  ),
  "BLOG",
);

assert.equal(
  classifySitemapUrl(
    "https://example.com/en-en/blogs/news/article",
  ),
  "ARTICLE",
);

console.log(
  "SITEMAP_AUDIT_LOCALE_CLASSIFICATION_PASS",
);

assert.equal(
  normalizeComparableUrl(
    "https://example.com/products/test/#fragment",
  ),
  "https://example.com/products/test",
);

const xmlByUrl =
  new Map([
    [
      "https://example.com/sitemap.xml",
      rootXml,
    ],
    [
      "https://example.com/sitemap_products_1.xml",
      productXml,
    ],
    [
      "https://example.com/sitemap_content_1.xml",
      contentXml,
    ],
  ]);

const fetchXml =
  async ({ url }) => {
    const body =
      xmlByUrl.get(url);

    if (!body) {
      throw new Error(
        `UNEXPECTED_XML_URL:${url}`,
      );
    }

    return {
      requestedUrl: url,
      finalUrl: url,
      statusCode: 200,
      body,
      redirectChain: [],
      contentType:
        "application/xml",
    };
  };

const fetchPage =
  async ({ url }) => {
    const isAbout =
      url.endsWith(
        "/pages/about",
      );

    const canonical =
      url;

    const html =
      `<!doctype html>
<html>
<head>
<title>Test</title>
<meta name="description" content="Test page">
${
  isAbout
    ? '<meta name="robots" content="noindex,follow">'
    : ""
}
<link rel="canonical" href="${canonical}">
</head>
<body>
<h1>Test</h1>
</body>
</html>`;

    return {
      requestedUrl:
        url,
      finalUrl:
        url,
      statusCode:
        200,
      html,
      redirectChain:
        [],
      xRobotsTag:
        null,
      contentType:
        "text/html",
    };
  };

const result =
  await runSitemapAudit({
    primaryDomain:
      "example.com",
    maxPageChecks:
      10,
    fetchXml,
    fetchPage,
  });

assert.equal(
  result.sitemapDocumentsFetched,
  3,
);

assert.equal(
  result.totalUrls,
  5,
);

assert.equal(
  result.totalImages,
  2,
);

assert.equal(
  result.uniqueImages,
  2,
);

assert.equal(
  result.resourceCounts.PRODUCT,
  1,
);

assert.equal(
  result.resourceCounts.COLLECTION,
  1,
);

assert.equal(
  result.resourceCounts.PAGE,
  1,
);

assert.equal(
  result.resourceCounts.BLOG,
  1,
);

assert.equal(
  result.resourceCounts.ARTICLE,
  1,
);

assert.equal(
  result.pageChecks.requested,
  5,
);

assert.equal(
  result.pageChecks.failed,
  0,
);

assert.equal(
  result.pageChecks.noindex,
  1,
);

assert.equal(
  result.issues.countByCode
    .SITEMAP_ENTRY_NOINDEX,
  1,
);

const negativeRootXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap_negative.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap_negative.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://evil.example/sitemap.xml</loc>
  </sitemap>
</sitemapindex>`;

const negativeChildXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/products/redirect-me</loc>
  </url>
  <url>
    <loc>https://example.com/products/redirect-me/</loc>
  </url>
  <url>
    <loc>https://example.com/collections/missing</loc>
  </url>
  <url>
    <loc>https://example.com/pages/canonical-mismatch</loc>
  </url>
</urlset>`;

const negativeXmlByUrl =
  new Map([
    [
      "https://example.com/sitemap.xml",
      negativeRootXml,
    ],
    [
      "https://example.com/sitemap_negative.xml",
      negativeChildXml,
    ],
  ]);

const negativeFetchXml =
  async ({ url }) => {
    const body =
      negativeXmlByUrl.get(url);

    if (!body) {
      throw new Error(
        `UNEXPECTED_NEGATIVE_XML_URL:${url}`,
      );
    }

    return {
      requestedUrl: url,
      finalUrl: url,
      statusCode: 200,
      body,
      redirectChain: [],
      contentType:
        "application/xml",
    };
  };

const negativeFetchPage =
  async ({ url }) => {

    if (
      url ===
      "https://example.com/products/redirect-me"
    ) {
      const finalUrl =
        "https://example.com/products/redirect-target";

      return {
        requestedUrl: url,
        finalUrl,
        statusCode: 200,
        html: `<!doctype html>
<html>
<head>
<title>Redirect target</title>
<meta name="description" content="Redirect target">
<link rel="canonical" href="${finalUrl}">
</head>
<body>
<h1>Redirect target</h1>
</body>
</html>`,
        redirectChain: [
          finalUrl,
        ],
        xRobotsTag: null,
        contentType:
          "text/html",
      };
    }

    if (
      url ===
      "https://example.com/collections/missing"
    ) {
      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 404,
        html: `<!doctype html>
<html>
<head>
<title>Missing</title>
<meta name="description" content="Missing">
<link rel="canonical" href="${url}">
</head>
<body>
<h1>Missing</h1>
</body>
</html>`,
        redirectChain: [],
        xRobotsTag: null,
        contentType:
          "text/html",
      };
    }

    if (
      url ===
      "https://example.com/pages/canonical-mismatch"
    ) {
      const canonical =
        "https://example.com/pages/canonical-target";

      return {
        requestedUrl: url,
        finalUrl: url,
        statusCode: 200,
        html: `<!doctype html>
<html>
<head>
<title>Canonical mismatch</title>
<meta name="description" content="Canonical mismatch">
<link rel="canonical" href="${canonical}">
</head>
<body>
<h1>Canonical mismatch</h1>
</body>
</html>`,
        redirectChain: [],
        xRobotsTag: null,
        contentType:
          "text/html",
      };
    }

    throw new Error(
      `UNEXPECTED_NEGATIVE_PAGE_URL:${url}`,
    );
  };

const negativeResult =
  await runSitemapAudit({
    primaryDomain:
      "example.com",
    maxPageChecks:
      10,
    fetchXml:
      negativeFetchXml,
    fetchPage:
      negativeFetchPage,
  });

assert.equal(
  negativeResult.sitemapDocumentsFetched,
  2,
);

assert.equal(
  negativeResult.totalUrls,
  3,
);

assert.equal(
  negativeResult.duplicateUrls,
  1,
);

assert.equal(
  negativeResult.pageChecks.requested,
  3,
);

assert.equal(
  negativeResult.pageChecks.redirects,
  1,
);

assert.equal(
  negativeResult.pageChecks.clientErrors,
  1,
);

assert.equal(
  negativeResult.pageChecks.serverErrors,
  0,
);

assert.equal(
  negativeResult.pageChecks.canonicalMismatch,
  1,
);

assert.equal(
  negativeResult.issues.countByCode
    .SITEMAP_CHILD_DUPLICATE_REFERENCE,
  1,
);

assert.equal(
  negativeResult.issues.countByCode
    .SITEMAP_CHILD_INVALID_OR_EXTERNAL,
  1,
);

assert.equal(
  negativeResult.issues.countByCode
    .SITEMAP_URL_DUPLICATE,
  1,
);

assert.equal(
  negativeResult.issues.countByCode
    .SITEMAP_ENTRY_REDIRECTS,
  1,
);

assert.equal(
  negativeResult.issues.countByCode
    .SITEMAP_ENTRY_HTTP_404,
  1,
);

assert.equal(
  negativeResult.issues.countByCode
    .SITEMAP_ENTRY_CANONICAL_MISMATCH,
  1,
);

assert.throws(
  () =>
    parseSitemapXml(
      "<unsupported />",
      "https://example.com/sitemap.xml",
    ),
  /SITEMAP_XML_ROOT_UNSUPPORTED/,
);

await assert.rejects(
  () =>
    runSitemapAudit({
      primaryDomain:
        "example.com",
      maxPageChecks:
        1.5,
      fetchXml,
      fetchPage,
    }),
  /SITEMAP_INVALID_PAGE_CHECK_LIMIT/,
);

const boundedUrls =
  Array.from(
    {
      length: 30,
    },
    (_, index) =>
      `  <url>
    <loc>https://example.com/pages/bounded-${index + 1}</loc>
  </url>`,
  ).join("\n");

const boundedRootXml =
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${boundedUrls}
</urlset>`;

const boundedFetchXml =
  async ({ url }) => {
    assert.equal(
      url,
      "https://example.com/sitemap.xml",
    );

    return {
      requestedUrl: url,
      finalUrl: url,
      statusCode: 200,
      body:
        boundedRootXml,
      redirectChain: [],
      contentType:
        "application/xml",
    };
  };

let boundedFetchCount =
  0;

const boundedFetchPage =
  async ({ url }) => {
    boundedFetchCount +=
      1;

    return {
      requestedUrl:
        url,
      finalUrl:
        url,
      statusCode:
        200,
      html:
        `<!doctype html>
<html>
<head>
<title>Bounded test</title>
<meta name="description" content="Bounded test">
<link rel="canonical" href="${url}">
</head>
<body>
<h1>Bounded test</h1>
</body>
</html>`,
      redirectChain:
        [],
      xRobotsTag:
        null,
      contentType:
        "text/html",
    };
  };

const boundedResult =
  await runSitemapAudit({
    primaryDomain:
      "example.com",
    maxPageChecks:
      26,
    fetchXml:
      boundedFetchXml,
    fetchPage:
      boundedFetchPage,
  });

assert.equal(
  boundedResult.totalUrls,
  30,
);

assert.equal(
  boundedResult.pageChecks.requested,
  25,
);

assert.equal(
  boundedFetchCount,
  25,
);

console.log(
  "SITEMAP_AUDIT_PAGE_CHECK_BOUNDARY_PASS",
);

const nonHtmlXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/agents.md</loc>
  </url>
</urlset>`;

const nonHtmlFetchXml =
  async ({ url }) => ({
    requestedUrl:
      url,
    finalUrl:
      url,
    statusCode:
      200,
    body:
      nonHtmlXml,
    redirectChain:
      [],
    contentType:
      "application/xml",
  });

const nonHtmlFetchPage =
  async ({ url }) => ({
    requestedUrl:
      url,
    finalUrl:
      url,
    statusCode:
      200,
    html:
      "# Agents",
    redirectChain:
      [],
    xRobotsTag:
      null,
    contentType:
      "text/markdown; charset=utf-8",
  });

const nonHtmlResult =
  await runSitemapAudit({
    primaryDomain:
      "example.com",
    maxPageChecks:
      1,
    fetchXml:
      nonHtmlFetchXml,
    fetchPage:
      nonHtmlFetchPage,
  });

assert.equal(
  nonHtmlResult.pageChecks.requested,
  1,
);

assert.equal(
  nonHtmlResult.pageChecks.failed,
  0,
);

assert.equal(
  nonHtmlResult.pageChecks.canonicalMismatch,
  0,
);

assert.equal(
  nonHtmlResult.pageChecks.pages[0].canonicalUrl,
  null,
);

assert.equal(
  nonHtmlResult.pageChecks.pages[0].contentType,
  "text/markdown; charset=utf-8",
);

assert.equal(
  nonHtmlResult.issues.countByCode
    .SITEMAP_ENTRY_CANONICAL_MISSING ??
    0,
  0,
);

console.log(
  "SITEMAP_AUDIT_NON_HTML_PASS",
);

console.log(
  "SITEMAP_AUDIT_NEGATIVE_CASES_PASS",
);
console.log(
  "SITEMAP_AUDIT_VERIFY_PASS",
);

console.log(
  JSON.stringify(
    {
      sitemapDocuments:
        result.sitemapDocumentsFetched,
      totalUrls:
        result.totalUrls,
      totalImages:
        result.totalImages,
      resourceCounts:
        result.resourceCounts,
      pageChecks:
        result.pageChecks.requested,
      noindex:
        result.pageChecks.noindex,
    },
    null,
    2,
  ),
);
