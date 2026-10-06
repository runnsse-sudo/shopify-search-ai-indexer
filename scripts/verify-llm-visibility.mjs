import assert from "node:assert/strict";

import {
  AI_CRAWLERS,
  analyzeLlmsDocument,
  buildLlmsFullTxtPreview,
  buildLlmsTxtPreview,
  calculateLlmVisibilityScore,
  evaluateRobotsAccess,
  parseRobotsTxt,
} from "../build-tests/llm-visibility.mjs";

import {
  runLlmVisibilityAudit,
} from "../build-tests/llm-visibility-server.mjs";


const crawlerTokens =
  AI_CRAWLERS.map(
    (
      crawler,
    ) =>
      crawler.token,
  );


assert.deepEqual(
  crawlerTokens,
  [
    "OAI-SearchBot",
    "GPTBot",
    "Claude-SearchBot",
    "ClaudeBot",
    "PerplexityBot",
    "Google-Extended",
  ],
);


const robotsText = `
# Shared fallback
User-agent: *
Disallow: /admin
Allow: /

User-agent: OAI-SearchBot
Allow: /
Disallow: /private

User-agent: Claude-SearchBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /

Sitemap: https://example.com/sitemap.xml
`;


const parsedRobots =
  parseRobotsTxt(
    robotsText,
  );


assert.equal(
  parsedRobots
    .groups.length,
  7,
);


assert.deepEqual(
  parsedRobots.sitemaps,
  [
    "https://example.com/sitemap.xml",
  ],
);


assert.equal(
  evaluateRobotsAccess(
    parsedRobots,
    "OAI-SearchBot",
    "/products/widget",
  ),
  "ALLOW",
);


assert.equal(
  evaluateRobotsAccess(
    parsedRobots,
    "OAI-SearchBot",
    "/private/data",
  ),
  "DISALLOW",
);


assert.equal(
  evaluateRobotsAccess(
    parsedRobots,
    "UnknownCrawler",
    "/admin/settings",
  ),
  "DISALLOW",
);


assert.equal(
  evaluateRobotsAccess(
    parsedRobots,
    "UnknownCrawler",
    "/products/widget",
  ),
  "ALLOW",
);


const wildcardRobots =
  parseRobotsTxt(`
User-agent: *
Disallow: /products/*?view=*
Allow: /products/public$
`);


assert.equal(
  evaluateRobotsAccess(
    wildcardRobots,
    "TestBot",
    "/products/item?view=quick",
  ),
  "DISALLOW",
);


assert.equal(
  evaluateRobotsAccess(
    wildcardRobots,
    "TestBot",
    "/products/public",
  ),
  "ALLOW",
);


const llmsBody =
  `# Example Store

> Example summary.

## Products
- [Widget](https://example.com/products/widget)
- https://example.com/collections/all
`;


const llmsAnalysis =
  analyzeLlmsDocument(
    llmsBody,
  );


assert.equal(
  llmsAnalysis.nonEmpty,
  true,
);


assert.equal(
  llmsAnalysis.h1Count,
  1,
);


assert.equal(
  llmsAnalysis.headingCount,
  2,
);


assert.equal(
  llmsAnalysis
    .markdownLinkCount,
  1,
);


assert.equal(
  llmsAnalysis.structured,
  true,
);


const sampleUrls = [
  {
    url:
      "https://example.com/products/widget",

    resourceType:
      "PRODUCT",
  },
  {
    url:
      "https://example.com/collections/all",

    resourceType:
      "COLLECTION",
  },
];


const preview =
  buildLlmsTxtPreview({
    primaryHost:
      "example.com",

    sitemapUrl:
      "https://example.com/sitemap.xml",

    sampleUrls,
  });


const fullPreview =
  buildLlmsFullTxtPreview({
    primaryHost:
      "example.com",

    sitemapUrl:
      "https://example.com/sitemap.xml",

    sampleUrls,
  });


assert.match(
  preview,
  /^# example\.com/m,
);


assert.match(
  preview,
  /https:\/\/example\.com\/sitemap\.xml/,
);


assert.match(
  fullPreview,
  /PRODUCT: https:\/\/example\.com\/products\/widget/,
);


assert.equal(
  calculateLlmVisibilityScore({
    robotsStatusCode:
      200,

    searchCrawlerAccess: [
      {
        token:
          "OAI-SearchBot",

        allRepresentativePathsAllowed:
          true,

        rootAllowed:
          true,
      },
      {
        token:
          "Claude-SearchBot",

        allRepresentativePathsAllowed:
          true,

        rootAllowed:
          true,
      },
      {
        token:
          "PerplexityBot",

        allRepresentativePathsAllowed:
          true,

        rootAllowed:
          true,
      },
    ],

    robotsSitemapCount:
      1,

    llmsTxtPresent:
      true,

    llmsFullTxtPresent:
      false,

    sampledNoindex:
      0,

    sampledCanonicalMismatch:
      0,
  }),
  95,
);


const resourceByUrl =
  new Map([
    [
      "https://example.com/robots.txt",
      {
        statusCode:
          200,

        body:
          robotsText,

        contentType:
          "text/plain",
      },
    ],
    [
      "https://example.com/llms.txt",
      {
        statusCode:
          200,

        body:
          llmsBody,

        contentType:
          "text/plain",
      },
    ],
    [
      "https://example.com/llms-full.txt",
      {
        statusCode:
          404,

        body:
          "Not found",

        contentType:
          "text/plain",
      },
    ],
  ]);


const fetchText =
  async (
    input,
  ) => {
    const fixture =
      resourceByUrl.get(
        input.url,
      );


    if (!fixture) {
      throw new Error(
        `UNEXPECTED_LLM_RESOURCE:${input.url}`,
      );
    }


    assert.equal(
      input.allowedHost,
      "example.com",
    );


    assert.ok(
      input.maxBodyBytes >=
      1024 * 1024,
    );


    return {
      requestedUrl:
        input.url,

      finalUrl:
        input.url,

      statusCode:
        fixture.statusCode,

      body:
        fixture.body,

      redirectChain:
        [],

      contentType:
        fixture.contentType,

      xRobotsTag:
        null,
    };
  };


let sitemapRunnerCalls =
  0;


const sitemapRunner =
  async (
    input,
  ) => {
    sitemapRunnerCalls +=
      1;


    assert.equal(
      input.primaryDomain,
      "example.com",
    );


    assert.equal(
      input.maxPageChecks,
      8,
    );


    return {
      rootSitemapUrl:
        "https://example.com/sitemap.xml",

      primaryHost:
        "example.com",

      sitemapDocumentsFetched:
        3,

      sitemapDocumentsDiscovered:
        3,

      totalUrls:
        120,

      duplicateUrls:
        0,

      invalidUrls:
        0,

      totalImages:
        10,

      uniqueImages:
        10,

      urlsWithImages:
        5,

      resourceCounts: {
        PRODUCT:
          80,

        COLLECTION:
          10,

        PAGE:
          10,

        BLOG:
          5,

        ARTICLE:
          15,

        OTHER:
          0,
      },

      pageChecks: {
        requested:
          8,

        succeeded:
          8,

        failed:
          0,

        redirects:
          0,

        noindex:
          0,

        canonicalMismatch:
          0,

        clientErrors:
          0,

        serverErrors:
          0,

        pages:
          [],
      },

      issues: {
        total:
          0,

        truncated:
          false,

        countByCode:
          {},

        samples:
          [],
      },

      sampleSitemaps:
        [],

      sampleUrls:
        sampleUrls.map(
          (
            entry,
          ) => ({
            ...entry,

            lastmod:
              null,

            imageCount:
              0,

            sourceSitemap:
              "https://example.com/sitemap.xml",
          }),
        ),
    };
  };


const result =
  await runLlmVisibilityAudit({
    primaryDomain:
      "example.com",

    fetchText,

    sitemapRunner,
  });


assert.equal(
  sitemapRunnerCalls,
  1,
);


assert.equal(
  result.primaryHost,
  "example.com",
);


assert.equal(
  result.score,
  95,
);


assert.equal(
  result.scoreLabel,
  "STRONG",
);


assert.equal(
  result.robots
    .statusCode,
  200,
);


assert.equal(
  result.robots
    .sitemapCount,
  1,
);


assert.equal(
  result.llmsTxt
    .analysis
    ?.structured,
  true,
);


assert.equal(
  result.llmsFullTxt
    .statusCode,
  404,
);


assert.equal(
  result.sitemap
    .sampledPages,
  8,
);


const oai =
  result.crawlers.find(
    (
      crawler,
    ) =>
      crawler.token ===
      "OAI-SearchBot",
  );


assert.equal(
  oai?.rootAccess,
  "ALLOW",
);


assert.equal(
  oai
    ?.allRepresentativePathsAllowed,
  true,
);


const gptBot =
  result.crawlers.find(
    (
      crawler,
    ) =>
      crawler.token ===
      "GPTBot",
  );


assert.equal(
  gptBot?.rootAccess,
  "DISALLOW",
);


assert.equal(
  gptBot
    ?.searchVisibilityRelevant,
  false,
);


const googleExtended =
  result.crawlers.find(
    (
      crawler,
    ) =>
      crawler.token ===
      "Google-Extended",
  );


assert.equal(
  googleExtended
    ?.rootAccess,
  "DISALLOW",
);


assert.equal(
  result.recommendations
    .some(
      (
        item,
      ) =>
        item.code ===
        "LLMS_FULL_TXT_MISSING",
    ),
  true,
);


assert.equal(
  result.recommendations
    .some(
      (
        item,
      ) =>
        item.code.includes(
          "GPTBOT",
        ),
    ),
  false,
);


await assert.rejects(
  () =>
    runLlmVisibilityAudit({
      primaryDomain:
        "http://example.com",

      fetchText,

      sitemapRunner,
    }),
  /LLM_VISIBILITY_HTTPS_REQUIRED/,
);


await assert.rejects(
  () =>
    runLlmVisibilityAudit({
      primaryDomain:
        "https://example.com:4443",

      fetchText,

      sitemapRunner,
    }),
  /LLM_VISIBILITY_NON_DEFAULT_PORT_NOT_ALLOWED/,
);


await assert.rejects(
  () =>
    runLlmVisibilityAudit({
      primaryDomain:
        "127.0.0.1",

      fetchText,

      sitemapRunner,
    }),
  /LLM_VISIBILITY_IP_LITERAL_NOT_ALLOWED/,
);


console.log(
  "LLM_VISIBILITY_CRAWLER_REGISTRY_PASS",
);

console.log(
  "LLM_VISIBILITY_ROBOTS_PARSER_PASS",
);

console.log(
  "LLM_VISIBILITY_ROBOTS_POLICY_PASS",
);

console.log(
  "LLM_VISIBILITY_LLMS_ANALYSIS_PASS",
);

console.log(
  "LLM_VISIBILITY_PREVIEW_PASS",
);

console.log(
  "LLM_VISIBILITY_SCORE_PASS",
);

console.log(
  "LLM_VISIBILITY_SERVER_INTEGRATION_PASS",
);

console.log(
  "LLM_VISIBILITY_SECURITY_INPUT_PASS",
);

console.log(
  "LLM_VISIBILITY_VERIFY_PASS",
);