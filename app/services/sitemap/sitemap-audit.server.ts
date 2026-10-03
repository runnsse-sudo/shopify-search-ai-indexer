import type {
  SeoPageType,
} from "../seo-audit/html-audit";
import {
  auditHtml,
} from "../seo-audit/html-audit";
import {
  fetchStorefrontPage,
  type StorefrontFetchInput,
  type StorefrontFetchResult,
} from "../seo-audit/storefront-fetch.server";
import {
  classifySitemapUrl,
  normalizeComparableUrl,
  parseSitemapXml,
  type ParsedSitemapDocument,
  type SitemapResourceType,
  type SitemapUrlEntry,
} from "./sitemap-audit";

export type SitemapIssueSeverity =
  | "INFO"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type SitemapAuditIssue = {
  code: string;
  severity: SitemapIssueSeverity;
  message: string;
  url?: string | null;
};

export type SitemapXmlFetchInput = {
  url: string;
  allowedHost: string;
};

export type SitemapXmlFetchResult = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  body: string;
  redirectChain: string[];
  contentType: string | null;
};

export type SitemapXmlFetcher = (
  input: SitemapXmlFetchInput,
) => Promise<SitemapXmlFetchResult>;

export type SitemapPageFetcher = (
  input: StorefrontFetchInput,
) => Promise<StorefrontFetchResult>;

export type SitemapPageCheck = {
  url: string;
  resourceType: SitemapResourceType;
  statusCode: number | null;
  finalUrl: string | null;
  redirectCount: number;
  contentType: string | null;
  canonicalUrl: string | null;
  canonicalMismatch: boolean | null;
  noindex: boolean | null;
  error: string | null;
};

export type SitemapAuditResult = {
  rootSitemapUrl: string;
  primaryHost: string;

  sitemapDocumentsFetched: number;
  sitemapDocumentsDiscovered: number;

  totalUrls: number;
  duplicateUrls: number;
  invalidUrls: number;

  totalImages: number;
  uniqueImages: number;
  urlsWithImages: number;

  resourceCounts: Record<
    SitemapResourceType,
    number
  >;

  pageChecks: {
    requested: number;
    succeeded: number;
    failed: number;
    redirects: number;
    noindex: number;
    canonicalMismatch: number;
    clientErrors: number;
    serverErrors: number;
    pages: SitemapPageCheck[];
  };

  issues: {
    total: number;
    truncated: boolean;
    countByCode: Record<
      string,
      number
    >;
    samples: SitemapAuditIssue[];
  };

  sampleSitemaps: Array<{
    url: string;
    kind: string | null;
    statusCode: number;
  }>;

  sampleUrls: Array<{
    url: string;
    resourceType:
      SitemapResourceType;
    lastmod: string | null;
    imageCount: number;
    sourceSitemap: string;
  }>;
};

const DEFAULT_MAX_SITEMAP_DOCUMENTS =
  50;

const DEFAULT_MAX_URLS =
  100_000;

const DEFAULT_MAX_PAGE_CHECKS =
  12;

const MAX_PAGE_CHECKS =
  25;

const ISSUE_SAMPLE_LIMIT =
  100;

const XML_BODY_LIMIT =
  20 * 1024 * 1024;

function normalizeHost(
  host: string,
) {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function storefrontBase(
  value: string,
) {
  const trimmed =
    value.trim();

  const parsed =
    trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(
          `https://${trimmed}`,
        );

  if (
    parsed.protocol !== "https:"
  ) {
    throw new Error(
      "SITEMAP_HTTPS_REQUIRED",
    );
  }

  if (
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "SITEMAP_URL_CREDENTIALS_NOT_ALLOWED",
    );
  }

  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";

  return parsed;
}

function resolveStorefrontUrl(
  raw: string,
  baseUrl: string,
  allowedHost: string,
): string | null {
  try {
    const parsed =
      new URL(
        raw.trim(),
        baseUrl,
      );

    if (
      parsed.protocol !== "https:"
    ) {
      return null;
    }

    if (
      parsed.username ||
      parsed.password
    ) {
      return null;
    }

    if (
      normalizeHost(
        parsed.hostname,
      ) !==
      normalizeHost(
        allowedHost,
      )
    ) {
      return null;
    }

    parsed.hash = "";

    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveImageUrl(
  raw: string,
  pageUrl: string,
): string | null {
  try {
    const parsed =
      new URL(
        raw.trim(),
        pageUrl,
      );

    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:"
    ) {
      return null;
    }

    parsed.hash = "";

    return parsed.toString();
  } catch {
    return null;
  }
}

async function defaultXmlFetcher(
  input: SitemapXmlFetchInput,
): Promise<SitemapXmlFetchResult> {
  const fetched =
    await fetchStorefrontPage({
      url:
        input.url,
      allowedHost:
        input.allowedHost,
      maxRedirects:
        5,
      timeoutMs:
        15_000,
      maxBodyBytes:
        XML_BODY_LIMIT,
      maxRetries:
        1,
      retryBaseDelayMs:
        250,
    });

  return {
    requestedUrl:
      fetched.requestedUrl,
    finalUrl:
      fetched.finalUrl,
    statusCode:
      fetched.statusCode,
    body:
      fetched.html,
    redirectChain:
      fetched.redirectChain,
    contentType:
      fetched.contentType,
  };
}

function isHtmlContentType(
  value: string | null,
) {
  if (!value) {
    return true;
  }

  const mediaType =
    value
      .split(";", 1)[0]
      .trim()
      .toLowerCase();

  return (
    mediaType === "text/html" ||
    mediaType ===
      "application/xhtml+xml"
  );
}

function xRobotsHasNoindex(
  value: string | null,
) {
  if (!value) {
    return false;
  }

  return value
    .toLowerCase()
    .split(",")
    .map((directive) =>
      directive.trim(),
    )
    .some(
      (directive) =>
        directive === "noindex" ||
        directive.endsWith(
          ": noindex",
        ),
    );
}

function expectedPageType(
  resourceType:
    SitemapResourceType,
): SeoPageType {
  if (
    resourceType === "PRODUCT"
  ) {
    return "PRODUCT";
  }

  if (
    resourceType ===
    "COLLECTION"
  ) {
    return "COLLECTION";
  }

  if (
    resourceType === "PAGE"
  ) {
    return "PAGE";
  }

  if (
    resourceType ===
    "ARTICLE"
  ) {
    return "ARTICLE";
  }

  return "UNKNOWN";
}

function emptyResourceCounts():
  Record<
    SitemapResourceType,
    number
  > {
  return {
    PRODUCT: 0,
    COLLECTION: 0,
    PAGE: 0,
    BLOG: 0,
    ARTICLE: 0,
    OTHER: 0,
  };
}

function clampPageChecks(
  value?: number,
) {
  if (
    value === undefined
  ) {
    return DEFAULT_MAX_PAGE_CHECKS;
  }

  if (
    !Number.isInteger(value)
  ) {
    throw new Error(
      "SITEMAP_INVALID_PAGE_CHECK_LIMIT",
    );
  }

  return Math.min(
    Math.max(
      value,
      0,
    ),
    MAX_PAGE_CHECKS,
  );
}

type ValidatedEntry = {
  url: string;
  resourceType:
    SitemapResourceType;
  lastmod: string | null;
  images: string[];
  sourceSitemap: string;
};

function selectPageChecks(
  entries: ValidatedEntry[],
  limit: number,
) {
  if (limit === 0) {
    return [];
  }

  const selected:
    ValidatedEntry[] = [];

  const selectedUrls =
    new Set<string>();

  const preferredTypes:
    SitemapResourceType[] = [
      "PRODUCT",
      "COLLECTION",
      "PAGE",
      "BLOG",
      "ARTICLE",
      "OTHER",
    ];

  for (
    const resourceType
    of preferredTypes
  ) {
    const candidate =
      entries.find(
        (entry) =>
          entry.resourceType ===
          resourceType,
      );

    if (
      candidate &&
      selected.length < limit
    ) {
      selected.push(candidate);
      selectedUrls.add(
        candidate.url,
      );
    }
  }

  for (const entry of entries) {
    if (
      selected.length >= limit
    ) {
      break;
    }

    if (
      selectedUrls.has(
        entry.url,
      )
    ) {
      continue;
    }

    selected.push(entry);
    selectedUrls.add(
      entry.url,
    );
  }

  return selected;
}

export async function runSitemapAudit(
  input: {
    primaryDomain: string;
    maxSitemapDocuments?: number;
    maxUrls?: number;
    maxPageChecks?: number;
    fetchXml?: SitemapXmlFetcher;
    fetchPage?: SitemapPageFetcher;
  },
): Promise<SitemapAuditResult> {
  const base =
    storefrontBase(
      input.primaryDomain,
    );

  const allowedHost =
    base.hostname;

  const rootSitemapUrl =
    new URL(
      "/sitemap.xml",
      base,
    ).toString();

  const maxSitemapDocuments =
    input.maxSitemapDocuments ??
    DEFAULT_MAX_SITEMAP_DOCUMENTS;

  const maxUrls =
    input.maxUrls ??
    DEFAULT_MAX_URLS;

  const maxPageChecks =
    clampPageChecks(
      input.maxPageChecks,
    );

  if (
    !Number.isInteger(
      maxSitemapDocuments,
    ) ||
    maxSitemapDocuments < 1 ||
    maxSitemapDocuments > 250
  ) {
    throw new Error(
      "SITEMAP_INVALID_DOCUMENT_LIMIT",
    );
  }

  if (
    !Number.isInteger(
      maxUrls,
    ) ||
    maxUrls < 1 ||
    maxUrls > 500_000
  ) {
    throw new Error(
      "SITEMAP_INVALID_URL_LIMIT",
    );
  }

  const fetchXml =
    input.fetchXml ??
    defaultXmlFetcher;

  const fetchPage =
    input.fetchPage ??
    fetchStorefrontPage;

  let issueTotal =
    0;

  const issueSamples:
    SitemapAuditIssue[] = [];

  const issueCounts =
    new Map<
      string,
      number
    >();

  const recordIssue = (
    issue: SitemapAuditIssue,
  ) => {
    issueTotal += 1;

    issueCounts.set(
      issue.code,
      (
        issueCounts.get(
          issue.code,
        ) ?? 0
      ) + 1,
    );

    if (
      issueSamples.length <
      ISSUE_SAMPLE_LIMIT
    ) {
      issueSamples.push(
        issue,
      );
    }
  };

  const rootFetch =
    await fetchXml({
      url:
        rootSitemapUrl,
      allowedHost,
    });

  if (
    rootFetch.statusCode !== 200
  ) {
    throw new Error(
      `SITEMAP_ROOT_HTTP_${rootFetch.statusCode}`,
    );
  }

  let rootDocument:
    ParsedSitemapDocument;

  try {
    rootDocument =
      parseSitemapXml(
        rootFetch.body,
        rootFetch.finalUrl,
      );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "SITEMAP_ROOT_PARSE_FAILED";

    throw new Error(
      `SITEMAP_ROOT_INVALID:${message}`,
    );
  }

  const sampleSitemaps:
    SitemapAuditResult[
      "sampleSitemaps"
    ] = [
      {
        url:
          rootFetch.finalUrl,
        kind:
          rootDocument.kind,
        statusCode:
          rootFetch.statusCode,
      },
    ];

  let sitemapDocumentsFetched =
    1;

  let sitemapDocumentsDiscovered =
    1;

  const rawUrlEntries:
    Array<
      SitemapUrlEntry & {
        sourceSitemap: string;
      }
    > = [];

  const sitemapQueue:
    string[] = [];

  const seenSitemapUrls =
    new Set<string>([
      normalizeComparableUrl(
        rootFetch.finalUrl,
      ) ??
        rootFetch.finalUrl,
    ]);

  const enqueueChildren = (
    document:
      ParsedSitemapDocument,
  ) => {
    for (
      const child
      of document.sitemaps
    ) {
      const resolved =
        resolveStorefrontUrl(
          child.loc,
          document.sourceUrl,
          allowedHost,
        );

      if (!resolved) {
        recordIssue({
          code:
            "SITEMAP_CHILD_INVALID_OR_EXTERNAL",
          severity:
            "HIGH",
          message:
            "A child sitemap URL is invalid, non-HTTPS or outside the storefront host.",
          url:
            child.loc,
        });

        continue;
      }

      const key =
        normalizeComparableUrl(
          resolved,
        ) ?? resolved;

      if (
        seenSitemapUrls.has(
          key,
        )
      ) {
        recordIssue({
          code:
            "SITEMAP_CHILD_DUPLICATE_REFERENCE",
          severity:
            "LOW",
          message:
            "A child sitemap was referenced more than once.",
          url:
            resolved,
        });

        continue;
      }

      seenSitemapUrls.add(key);

      sitemapQueue.push(
        resolved,
      );

      sitemapDocumentsDiscovered +=
        1;
    }
  };

  const ingestDocument = (
    document:
      ParsedSitemapDocument,
  ) => {
    if (
      document.kind ===
      "INDEX"
    ) {
      enqueueChildren(
        document,
      );

      return;
    }

    for (
      const entry
      of document.urls
    ) {
      rawUrlEntries.push({
        ...entry,
        sourceSitemap:
          document.sourceUrl,
      });

      if (
        rawUrlEntries.length >
        maxUrls
      ) {
        throw new Error(
          "SITEMAP_URL_LIMIT_EXCEEDED",
        );
      }
    }
  };

  ingestDocument(
    rootDocument,
  );

  while (
    sitemapQueue.length > 0
  ) {
    if (
      sitemapDocumentsFetched >=
      maxSitemapDocuments
    ) {
      throw new Error(
        "SITEMAP_DOCUMENT_LIMIT_EXCEEDED",
      );
    }

    const sitemapUrl =
      sitemapQueue.shift();

    if (!sitemapUrl) {
      break;
    }

    let fetched:
      SitemapXmlFetchResult;

    try {
      fetched =
        await fetchXml({
          url:
            sitemapUrl,
          allowedHost,
        });
    } catch (error) {
      recordIssue({
        code:
          "SITEMAP_CHILD_FETCH_FAILED",
        severity:
          "HIGH",
        message:
          error instanceof Error
            ? error.message
            : "Child sitemap fetch failed.",
        url:
          sitemapUrl,
      });

      continue;
    }

    sitemapDocumentsFetched +=
      1;

    if (
      fetched.statusCode !== 200
    ) {
      recordIssue({
        code:
          `SITEMAP_CHILD_HTTP_${fetched.statusCode}`,
        severity:
          fetched.statusCode >= 500
            ? "CRITICAL"
            : "HIGH",
        message:
          `Child sitemap returned HTTP ${fetched.statusCode}.`,
        url:
          sitemapUrl,
      });

      sampleSitemaps.push({
        url:
          fetched.finalUrl,
        kind:
          null,
        statusCode:
          fetched.statusCode,
      });

      continue;
    }

    let parsed:
      ParsedSitemapDocument;

    try {
      parsed =
        parseSitemapXml(
          fetched.body,
          fetched.finalUrl,
        );
    } catch (error) {
      recordIssue({
        code:
          "SITEMAP_CHILD_PARSE_FAILED",
        severity:
          "HIGH",
        message:
          error instanceof Error
            ? error.message
            : "Child sitemap parse failed.",
        url:
          fetched.finalUrl,
      });

      sampleSitemaps.push({
        url:
          fetched.finalUrl,
        kind:
          null,
        statusCode:
          fetched.statusCode,
      });

      continue;
    }

    if (
      sampleSitemaps.length <
      25
    ) {
      sampleSitemaps.push({
        url:
          fetched.finalUrl,
        kind:
          parsed.kind,
        statusCode:
          fetched.statusCode,
      });
    }

    ingestDocument(
      parsed,
    );
  }

  const resourceCounts =
    emptyResourceCounts();

  const validatedEntries:
    ValidatedEntry[] = [];

  const seenUrls =
    new Set<string>();

  const uniqueImages =
    new Set<string>();

  let duplicateUrls =
    0;

  let invalidUrls =
    0;

  let totalImages =
    0;

  let urlsWithImages =
    0;

  for (
    const rawEntry
    of rawUrlEntries
  ) {
    const resolved =
      resolveStorefrontUrl(
        rawEntry.loc,
        rawEntry.sourceSitemap,
        allowedHost,
      );

    if (!resolved) {
      invalidUrls += 1;

      recordIssue({
        code:
          "SITEMAP_URL_INVALID_OR_EXTERNAL",
        severity:
          "HIGH",
        message:
          "A sitemap entry is invalid, non-HTTPS or outside the storefront host.",
        url:
          rawEntry.loc,
      });

      continue;
    }

    const comparable =
      normalizeComparableUrl(
        resolved,
      ) ?? resolved;

    if (
      seenUrls.has(
        comparable,
      )
    ) {
      duplicateUrls += 1;

      recordIssue({
        code:
          "SITEMAP_URL_DUPLICATE",
        severity:
          "MEDIUM",
        message:
          "The same canonical URL appears more than once in the sitemap inventory.",
        url:
          resolved,
      });

      continue;
    }

    seenUrls.add(
      comparable,
    );

    const resourceType =
      classifySitemapUrl(
        resolved,
      );

    resourceCounts[
      resourceType
    ] += 1;

    const images =
      rawEntry.images.flatMap(
        (rawImage) => {
          const image =
            resolveImageUrl(
              rawImage,
              resolved,
            );

          if (!image) {
            recordIssue({
              code:
                "SITEMAP_IMAGE_URL_INVALID",
              severity:
                "LOW",
              message:
                "An image sitemap entry contains an invalid URL.",
              url:
                rawImage,
            });

            return [];
          }

          return [image];
        },
      );

    if (
      images.length > 0
    ) {
      urlsWithImages += 1;
    }

    totalImages +=
      images.length;

    for (
      const image
      of images
    ) {
      uniqueImages.add(
        image,
      );
    }

    validatedEntries.push({
      url:
        resolved,
      resourceType,
      lastmod:
        rawEntry.lastmod,
      images,
      sourceSitemap:
        rawEntry.sourceSitemap,
    });
  }

  const targets =
    selectPageChecks(
      validatedEntries,
      maxPageChecks,
    );

  const pageChecks:
    SitemapPageCheck[] = [];

  let pageChecksSucceeded =
    0;

  let pageChecksFailed =
    0;

  let pageRedirects =
    0;

  let pageNoindex =
    0;

  let pageCanonicalMismatch =
    0;

  let pageClientErrors =
    0;

  let pageServerErrors =
    0;

  for (
    const target
    of targets
  ) {
    try {
      const fetched =
        await fetchPage({
          url:
            target.url,
          allowedHost,
          maxRedirects:
            5,
          timeoutMs:
            10_000,
          maxBodyBytes:
            5 * 1024 * 1024,
          maxRetries:
            1,
          retryBaseDelayMs:
            250,
        });

      const htmlContent =
        isHtmlContentType(
          fetched.contentType,
        );

      const audited =
        htmlContent
          ? auditHtml({
              requestedUrl:
                fetched.requestedUrl,
              finalUrl:
                fetched.finalUrl,
              statusCode:
                fetched.statusCode,
              html:
                fetched.html,
              xRobotsTag:
                fetched.xRobotsTag,
              redirectChain:
                fetched.redirectChain,
              expectedPageType:
                expectedPageType(
                  target.resourceType,
                ),
            })
          : null;

      const noindex =
        audited
          ? audited.noindex
          : xRobotsHasNoindex(
              fetched.xRobotsTag,
            );

      pageChecksSucceeded +=
        1;

      if (
        fetched.redirectChain.length >
        0
      ) {
        pageRedirects += 1;

        recordIssue({
          code:
            "SITEMAP_ENTRY_REDIRECTS",
          severity:
            "MEDIUM",
          message:
            "A URL listed in the sitemap redirects before reaching its final page.",
          url:
            target.url,
        });
      }

      if (
        fetched.statusCode >= 500
      ) {
        pageServerErrors += 1;

        recordIssue({
          code:
            `SITEMAP_ENTRY_HTTP_${fetched.statusCode}`,
          severity:
            "CRITICAL",
          message:
            `A sitemap URL returned HTTP ${fetched.statusCode}.`,
          url:
            target.url,
        });
      } else if (
        fetched.statusCode >= 400
      ) {
        pageClientErrors += 1;

        recordIssue({
          code:
            `SITEMAP_ENTRY_HTTP_${fetched.statusCode}`,
          severity:
            "HIGH",
          message:
            `A sitemap URL returned HTTP ${fetched.statusCode}.`,
          url:
            target.url,
        });
      }

      if (
        noindex
      ) {
        pageNoindex += 1;

        recordIssue({
          code:
            "SITEMAP_ENTRY_NOINDEX",
          severity:
            "HIGH",
          message:
            "A URL listed in the sitemap exposes a noindex directive.",
          url:
            target.url,
        });
      }

      let canonicalMismatch:
        boolean | null = null;

      if (
        audited &&
        audited.canonicalUrl
      ) {
        const canonicalComparable =
          normalizeComparableUrl(
            audited.canonicalUrl,
          );

        const finalComparable =
          normalizeComparableUrl(
            fetched.finalUrl,
          );

        canonicalMismatch =
          Boolean(
            canonicalComparable &&
            finalComparable &&
            canonicalComparable !==
              finalComparable,
          );

        if (
          canonicalMismatch
        ) {
          pageCanonicalMismatch +=
            1;

          recordIssue({
            code:
              "SITEMAP_ENTRY_CANONICAL_MISMATCH",
            severity:
              "HIGH",
            message:
              "A URL listed in the sitemap canonicalizes to a different URL.",
            url:
              target.url,
          });
        }
      } else if (audited) {
        canonicalMismatch =
          null;

        recordIssue({
          code:
            "SITEMAP_ENTRY_CANONICAL_MISSING",
          severity:
            "MEDIUM",
          message:
            "A checked HTML sitemap URL has no canonical link.",
          url:
            target.url,
        });
      } else {
        canonicalMismatch =
          null;
      }

      pageChecks.push({
        url:
          target.url,
        resourceType:
          target.resourceType,
        statusCode:
          fetched.statusCode,
        finalUrl:
          fetched.finalUrl,
        redirectCount:
          fetched.redirectChain.length,
        contentType:
          fetched.contentType,
        canonicalUrl:
          audited?.canonicalUrl ??
          null,
        canonicalMismatch,
        noindex,
        error:
          null,
      });
    } catch (error) {
      pageChecksFailed +=
        1;

      const message =
        error instanceof Error
          ? error.message
          : "Sitemap page check failed.";

      recordIssue({
        code:
          "SITEMAP_ENTRY_FETCH_FAILED",
        severity:
          "HIGH",
        message,
        url:
          target.url,
      });

      pageChecks.push({
        url:
          target.url,
        resourceType:
          target.resourceType,
        statusCode:
          null,
        finalUrl:
          null,
        redirectCount:
          0,
        contentType:
          null,
        canonicalUrl:
          null,
        canonicalMismatch:
          null,
        noindex:
          null,
        error:
          message,
      });
    }
  }

  const countByCode =
    Object.fromEntries(
      Array.from(
        issueCounts.entries(),
      ).sort(
        ([left], [right]) =>
          left.localeCompare(
            right,
          ),
      ),
    );

  return {
    rootSitemapUrl,
    primaryHost:
      allowedHost,

    sitemapDocumentsFetched,
    sitemapDocumentsDiscovered,

    totalUrls:
      validatedEntries.length,
    duplicateUrls,
    invalidUrls,

    totalImages,
    uniqueImages:
      uniqueImages.size,
    urlsWithImages,

    resourceCounts,

    pageChecks: {
      requested:
        targets.length,
      succeeded:
        pageChecksSucceeded,
      failed:
        pageChecksFailed,
      redirects:
        pageRedirects,
      noindex:
        pageNoindex,
      canonicalMismatch:
        pageCanonicalMismatch,
      clientErrors:
        pageClientErrors,
      serverErrors:
        pageServerErrors,
      pages:
        pageChecks,
    },

    issues: {
      total:
        issueTotal,
      truncated:
        issueTotal >
        issueSamples.length,
      countByCode,
      samples:
        issueSamples,
    },

    sampleSitemaps,

    sampleUrls:
      validatedEntries
        .slice(
          0,
          25,
        )
        .map(
          (entry) => ({
            url:
              entry.url,
            resourceType:
              entry.resourceType,
            lastmod:
              entry.lastmod,
            imageCount:
              entry.images.length,
            sourceSitemap:
              entry.sourceSitemap,
          }),
        ),
  };
}
