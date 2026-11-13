import assert from "node:assert/strict";
import { runAutomaticRedirectAudit } from "../build-tests/automatic-redirect-server.mjs";

import {
  extractInternalLinks,
  normalizeInternalUrl,
  normalizeSitemapDocumentUrl,
  suggestRedirect,
} from "../build-tests/redirect-audit.mjs";

import {
  isBlockedRedirectAuditAddress,
  recheckAutomaticRedirect,
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

assert.equal(
  normalizeInternalUrl(
    "https://example.com:4443/products/widget",
    "https://example.com/pages/home",
    "example.com",
  ),
  null,
);

assert.equal(
  normalizeSitemapDocumentUrl(
    "https://example.com:4443/sitemap.xml?from=1&to=2",
    "https://example.com/sitemap.xml",
    "example.com",
  ),
  null,
);

assert.equal(
  normalizeInternalUrl(
    "https://example.com:443/products/widget",
    "https://example.com/pages/home",
    "example.com",
  ),
  "https://example.com/products/widget",
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
assert.equal(highSuggestion?.eligibleForRecheck, true);

const ambiguousSuggestion = suggestRedirect(
  "https://example.com/en/blogs/old-blog/widget",
  [
    "https://example.com/en/blogs/new-blog/widget",
    "https://example.com/en/blogs/other-blog/widget",
  ],
);
assert.equal(ambiguousSuggestion?.confidence, "HIGH");
assert.equal(ambiguousSuggestion?.eligibleForRecheck, false);
const missingArticle = "https://example.com/en/blogs/old-blog/widget";
const automaticCandidate = {
  url: missingArticle,
  statusCode: 404,
  redirectChain: [],
  suggestion: highSuggestion,
};
const recheckRequests = [];
const directFetch = async ({ url }) => {
  recheckRequests.push(url);
  return {
    finalUrl: url,
    statusCode: url === missingArticle ? 404 : 200,
    redirectChain: [],
    loopDetected: false,
    contentType: "text/html; charset=utf-8",
    error: null,
  };
};
assert.deepEqual(
  await recheckAutomaticRedirect(automaticCandidate, "example.com", directFetch),
  { path: "/en/blogs/old-blog/widget", target: "/en/blogs/new-blog/widget" },
);
assert.deepEqual(recheckRequests, [missingArticle, highSuggestion.targetUrl]);
const auditShop = "audit-shop.myshopify.com";
const plan = { path: "/en/blogs/old-blog/widget", target: "/en/blogs/new-blog/widget" };
const audit = async () => ({
  primaryHost: "example.com",
  auditDeadlineMs: 5000,
  coverage: {},
  brokenInternalLinks: [automaticCandidate],
});
for (const scenario of ["create", "existing", "ambiguous", "missing-scope", "wrong-shop", "mutation-error"]) {
  const calls = [];
  const admin = {
    async graphql(query, options) {
      const operation = query.match(/(?:query|mutation) (\w+)/)[1];
      calls.push(operation);
      if (operation === "AutomaticRedirectIdentity") return Response.json({ data: {
        shop: { myshopifyDomain: scenario === "wrong-shop" ? "other.myshopify.com" : auditShop, primaryDomain: { host: "example.com" } },
        currentAppInstallation: { accessScopes: scenario === "missing-scope"
          ? [{ handle: "write_online_store_navigation" }]
          : [{ handle: "read_online_store_navigation" }, { handle: "write_online_store_navigation" }] },
      } });
      if (operation === "ExistingAutomaticRedirect") {
        assert.deepEqual(options.variables, { query: 'path:"/en/blogs/old-blog/widget"' });
        return Response.json({ data: { urlRedirects: { nodes: scenario === "existing" ? [{ path: plan.path }] : [], pageInfo: { hasNextPage: false } } } });
      }
      assert.equal(operation, "CreateAutomaticRedirect");
      assert.deepEqual(options.variables, { input: plan });
      return Response.json({ data: { urlRedirectCreate: scenario === "mutation-error"
        ? { urlRedirect: null, userErrors: [{ field: ["path"] }] }
        : { urlRedirect: { ...plan, id: "gid://shopify/UrlRedirect/1" }, userErrors: [] } } });
    },
  };
  const run = runAutomaticRedirectAudit(auditShop, admin, audit, async () => scenario === "ambiguous" ? null : plan);
  if (scenario === "wrong-shop" || scenario === "mutation-error") {
    await assert.rejects(run);
  } else {
    const outcome = await run;
    assert.equal(outcome.created.length, scenario === "create" ? 1 : 0);
  }
  assert.equal(calls.filter((op) => op === "CreateAutomaticRedirect").length,
    ["create", "mutation-error"].includes(scenario) ? 1 : 0);
}
assert.equal(
  await recheckAutomaticRedirect(automaticCandidate, "example.com", async (input) => ({
    ...await directFetch(input),
    redirectChain: [input.url],
  })),
  null,
);
assert.equal(
  await recheckAutomaticRedirect(automaticCandidate, "example.com", async (input) => ({
    ...await directFetch(input),
    statusCode: 200,
  })),
  null,
);
assert.equal(
  suggestRedirect("https://example.com/products/widget", [
    "https://other.example/products/widget",
  ]),
  null,
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

assert.doesNotThrow(
  () =>
    suggestRedirect(
      "https://example.com/products/%E0%A4%A",
      [
        "https://example.com/products/widget",
      ],
    ),
);

assert.equal(
  isBlockedRedirectAuditAddress(
    "127.0.0.1",
  ),
  true,
);

assert.equal(
  isBlockedRedirectAuditAddress(
    "10.10.10.10",
  ),
  true,
);

assert.equal(
  isBlockedRedirectAuditAddress(
    "169.254.169.254",
  ),
  true,
);

assert.equal(
  isBlockedRedirectAuditAddress(
    "192.168.1.1",
  ),
  true,
);

assert.equal(
  isBlockedRedirectAuditAddress(
    "::1",
  ),
  true,
);

assert.equal(
  isBlockedRedirectAuditAddress(
    "fc00::1",
  ),
  true,
);

assert.equal(
  isBlockedRedirectAuditAddress(
    "8.8.8.8",
  ),
  false,
);

assert.equal(
  isBlockedRedirectAuditAddress(
    "2606:4700:4700::1111",
  ),
  false,
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

const fetchDocumentFixture =
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

let activeNonSitemapFetches =
  0;

let maxActiveNonSitemapFetches =
  0;


const fetchDocument =
  async (
    input,
  ) => {
    const tracked =
      input.preserveSearch !==
      true;

    if (tracked) {
      activeNonSitemapFetches +=
        1;

      maxActiveNonSitemapFetches =
        Math.max(
          maxActiveNonSitemapFetches,
          activeNonSitemapFetches,
        );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            15,
          ),
      );
    }

    try {
      return await fetchDocumentFixture(
        input,
      );
    } finally {
      if (tracked) {
        activeNonSitemapFetches -=
          1;
      }
    }
  };


const result =
  await runRedirectAudit({
    primaryDomain:
      "example.com",
    maxSourcePages:
      3,
    maxLinkChecks:
      10,
    sourceConcurrency:
      2,
    linkConcurrency:
      3,
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

assert.equal(
  result.sourceConcurrency,
  2,
);

assert.equal(
  result.linkConcurrency,
  3,
);

assert.equal(
  result.auditDeadlineMs,
  180_000,
);

assert.equal(
  result.retriesPerformed,
  0,
);

assert.equal(
  result.coverage.auditDeadlineReached,
  false,
);

assert.equal(
  maxActiveNonSitemapFetches,
  3,
);

assert.ok(
  result.timings.sitemapMs >=
    0,
);

assert.ok(
  result.timings.sourcePagesMs >
    0,
);

assert.ok(
  result.timings.linkChecksMs >
    0,
);

assert.ok(
  result.timings.totalMs >=
    result.timings.sourcePagesMs,
);

assert.ok(
  result.timings.totalMs >=
    result.timings.linkChecksMs,
);

assert.equal(
  result.coverage.sitemapDocumentsTruncated,
  false,
);

assert.equal(
  result.coverage.sitemapUrlsTruncated,
  false,
);

assert.equal(
  result.coverage.sourcePagesTruncated,
  false,
);

assert.equal(
  result.coverage.internalLinksTruncated,
  false,
);

assert.deepEqual(
  result.brokenInternalLinks.map(
    (item) =>
      item.url,
  ),
  [
    "https://example.com/products/widget-old",
    "https://example.com/loop-a",
    "https://example.com/gone",
  ],
);


// ----------------------------------------------------------
// Explicit coverage-limit tests.
// ----------------------------------------------------------

const documentsLimited =
  await runRedirectAudit({
    primaryDomain:
      "example.com",
    maxSitemapDocuments:
      1,
    maxSourcePages:
      0,
    maxLinkChecks:
      0,
    fetchDocument:
      fetchDocumentFixture,
  });

assert.equal(
  documentsLimited.coverage.sitemapDocumentsTruncated,
  true,
);


const urlsLimited =
  await runRedirectAudit({
    primaryDomain:
      "example.com",
    maxSitemapUrls:
      1,
    maxSourcePages:
      0,
    maxLinkChecks:
      0,
    fetchDocument:
      fetchDocumentFixture,
  });

assert.equal(
  urlsLimited.coverage.sitemapUrlsTruncated,
  true,
);


const sourcesLimited =
  await runRedirectAudit({
    primaryDomain:
      "example.com",
    maxSourcePages:
      2,
    maxLinkChecks:
      0,
    fetchDocument:
      fetchDocumentFixture,
  });

assert.equal(
  sourcesLimited.coverage.sourcePagesTruncated,
  true,
);


const linksLimited =
  await runRedirectAudit({
    primaryDomain:
      "example.com",
    maxSourcePages:
      3,
    maxLinkChecks:
      2,
    fetchDocument:
      fetchDocumentFixture,
  });

assert.equal(
  linksLimited.coverage.internalLinksTruncated,
  true,
);


// ----------------------------------------------------------
// Transient status retries.
// ----------------------------------------------------------

let transientRootAttempts =
  0;

const transientFetch =
  async (
    input,
  ) => {
    if (
      input.url ===
      "https://example.com/sitemap.xml"
    ) {
      transientRootAttempts +=
        1;

      if (
        transientRootAttempts <=
        2
      ) {
        return {
          requestedUrl:
            input.url,
          finalUrl:
            input.url,
          statusCode:
            503,
          html: "",
          redirectChain: [],
          loopDetected:
            false,
          contentType:
            "text/plain",
          error:
            null,
        };
      }
    }

    return fetchDocumentFixture(
      input,
    );
  };


const retryResult =
  await runRedirectAudit({
    primaryDomain:
      "example.com",
    maxSourcePages:
      0,
    maxLinkChecks:
      0,
    maxAuditMs:
      5_000,
    fetchDocument:
      transientFetch,
  });


assert.equal(
  transientRootAttempts,
  3,
);

assert.equal(
  retryResult.retriesPerformed,
  2,
);

assert.equal(
  retryResult.coverage.auditDeadlineReached,
  false,
);


// ----------------------------------------------------------
// Fetch that finishes AFTER the global deadline must be
// classified as deadline exhaustion.
// ----------------------------------------------------------

const slowFetch =
  async (
    input,
  ) => {
    if (
      input.preserveSearch !==
      true
    ) {
      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            30,
          ),
      );
    }

    return fetchDocumentFixture(
      input,
    );
  };


const deadlineResult =
  await runRedirectAudit({
    primaryDomain:
      "example.com",
    maxSourcePages:
      3,
    maxLinkChecks:
      10,
    sourceConcurrency:
      1,
    linkConcurrency:
      1,
    maxAuditMs:
      10,
    fetchDocument:
      slowFetch,
  });


assert.equal(
  deadlineResult.auditDeadlineMs,
  10,
);

assert.equal(
  deadlineResult.coverage.auditDeadlineReached,
  true,
);

assert.equal(
  deadlineResult.coverage.sourcePagesTruncated,
  true,
);


// ----------------------------------------------------------
// IP literals and non-default storefront ports fail closed.
// ----------------------------------------------------------

await assert.rejects(
  () =>
    runRedirectAudit({
      primaryDomain:
        "127.0.0.1",
      fetchDocument:
        fetchDocumentFixture,
    }),
  /REDIRECT_AUDIT_IP_LITERAL_NOT_ALLOWED/,
);

await assert.rejects(
  () =>
    runRedirectAudit({
      primaryDomain:
        "https://example.com:4443",
      fetchDocument:
        fetchDocumentFixture,
    }),
  /REDIRECT_AUDIT_NON_DEFAULT_PORT_NOT_ALLOWED/,
);


// ----------------------------------------------------------
// Invalid concurrency/deadline must fail closed.
// ----------------------------------------------------------

await assert.rejects(
  () =>
    runRedirectAudit({
      primaryDomain:
        "example.com",
      sourceConcurrency:
        0,
      fetchDocument:
        fetchDocumentFixture,
    }),
  /REDIRECT_AUDIT_INVALID_SOURCE_CONCURRENCY/,
);

await assert.rejects(
  () =>
    runRedirectAudit({
      primaryDomain:
        "example.com",
      linkConcurrency:
        0,
      fetchDocument:
        fetchDocumentFixture,
    }),
  /REDIRECT_AUDIT_INVALID_LINK_CONCURRENCY/,
);

await assert.rejects(
  () =>
    runRedirectAudit({
      primaryDomain:
        "example.com",
      maxAuditMs:
        0,
      fetchDocument:
        fetchDocumentFixture,
    }),
  /REDIRECT_AUDIT_INVALID_DEADLINE/,
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
  "REDIRECT_AUDIT_PERFORMANCE_COVERAGE_PASS",
);

console.log(
  "REDIRECT_AUDIT_DETERMINISTIC_CONCURRENCY_PASS",
);

console.log(
  "REDIRECT_AUDIT_PORT_SECURITY_PASS",
);

console.log(
  "REDIRECT_AUDIT_MALFORMED_PATH_PASS",
);

console.log(
  "REDIRECT_AUDIT_ADDRESS_GUARD_PASS",
);

console.log(
  "REDIRECT_AUDIT_RETRY_PASS",
);

console.log(
  "REDIRECT_AUDIT_DEADLINE_PASS",
);

console.log(
  "REDIRECT_AUDIT_VERIFY_PASS",
);

assert.deepEqual(
  extractInternalLinks(
    '<!-- <a href="/comment"> --><iframe><a href="/frame"></a></iframe>' +
    '<noscript><a href="/fallback"></a></noscript><textarea><a href="/text"></a></textarea>' +
    '<a href="/products/real?one=1&amp;two=2">Real</a><a href="https://other.example/no">External</a>',
    "https://example.com/",
    "example.com",
  ),
  ["https://example.com/products/real"],
);
