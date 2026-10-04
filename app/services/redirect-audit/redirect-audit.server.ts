import {
  parseSitemapXml,
  classifySitemapUrl,
  type SitemapResourceType,
} from "../sitemap/sitemap-audit";
import {
  extractInternalLinks,
  normalizeInternalUrl,
  normalizeSitemapDocumentUrl,
  suggestRedirect,
  type RedirectConfidence,
  type RedirectSuggestion,
} from "./redirect-audit";

export type RedirectAuditFetchInput = {
  url: string;
  allowedHost: string;
  preserveSearch?: boolean;
};

export type RedirectAuditFetchResult = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  html: string;
  redirectChain: string[];
  loopDetected: boolean;
  contentType: string | null;
  error: string | null;
};

export type RedirectAuditFetcher = (
  input:
    RedirectAuditFetchInput,
) =>
  Promise<
    RedirectAuditFetchResult
  >;

export type RedirectAuditBrokenLink = {
  url: string;
  statusCode: number | null;
  error: string | null;
  sourceUrls: string[];
  redirectChain: string[];
  suggestion:
    RedirectSuggestion | null;
};

export type RedirectAuditRedirect = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  redirectChain: string[];
  hopCount: number;
  loopDetected: boolean;
};

export type RedirectAuditResult = {
  rootSitemapUrl: string;
  primaryHost: string;

  sitemapDocumentsFetched: number;
  sitemapUrls: number;

  sourcePagesRequested: number;
  sourcePagesSucceeded: number;
  sourcePagesFailed: number;

  internalLinksDiscovered: number;
  internalLinksChecked: number;
  internalLinksUnverified: number;

  notFoundCount: number;
  clientErrorCount: number;
  serverErrorCount: number;

  redirectCount: number;
  redirectChainCount: number;
  redirectLoopCount: number;

  brokenInternalLinkCount: number;

  suggestionCounts: Record<
    RedirectConfidence,
    number
  >;

  redirects:
    RedirectAuditRedirect[];

  brokenInternalLinks:
    RedirectAuditBrokenLink[];
};

const DEFAULT_MAX_SITEMAP_DOCUMENTS =
  50;

const DEFAULT_MAX_SITEMAP_URLS =
  100_000;

const DEFAULT_MAX_SOURCE_PAGES =
  20;

const MAX_SOURCE_PAGES =
  50;

const DEFAULT_MAX_LINK_CHECKS =
  100;

const MAX_LINK_CHECKS =
  250;

const MAX_REDIRECTS =
  10;

const MAX_BODY_BYTES =
  2 * 1024 * 1024;

function clampInteger(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  errorCode: string,
) {
  if (value === undefined) {
    return defaultValue;
  }

  if (
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      errorCode,
    );
  }

  return Math.min(
    value,
    maximum,
  );
}

function storefrontBase(
  value: string,
) {
  const parsed =
    value.includes("://")
      ? new URL(value)
      : new URL(
          `https://${value}`,
        );

  if (
    parsed.protocol !== "https:"
  ) {
    throw new Error(
      "REDIRECT_AUDIT_HTTPS_REQUIRED",
    );
  }

  if (
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "REDIRECT_AUDIT_CREDENTIALS_NOT_ALLOWED",
    );
  }

  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";

  return parsed;
}

function isRedirectStatus(
  value: number,
) {
  return (
    value === 301 ||
    value === 302 ||
    value === 303 ||
    value === 307 ||
    value === 308
  );
}

async function defaultFetchDocument(
  input:
    RedirectAuditFetchInput,
): Promise<
  RedirectAuditFetchResult
> {
  const requested =
    input.preserveSearch
      ? normalizeSitemapDocumentUrl(
          input.url,
          input.url,
          input.allowedHost,
        )
      : normalizeInternalUrl(
          input.url,
          input.url,
          input.allowedHost,
        );

  if (!requested) {
    throw new Error(
      "REDIRECT_AUDIT_INVALID_TARGET",
    );
  }

  let current =
    requested;

  const redirectChain:
    string[] = [];

  const seen =
    new Set<string>([
      requested,
    ]);

  for (
    let hop = 0;
    hop <= MAX_REDIRECTS;
    hop++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        15_000,
      );

    let response:
      Response;

    try {
      response =
        await fetch(
          current,
          {
            method: "GET",
            redirect: "manual",
            headers: {
              accept:
                "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.7",
              "user-agent":
                "RunnSearchAIIndexer-RedirectAudit/1.0",
            },
            signal:
              controller.signal,
          },
        );
    } finally {
      clearTimeout(timer);
    }

    if (
      isRedirectStatus(
        response.status,
      )
    ) {
      const location =
        response.headers.get(
          "location",
        );

      if (!location) {
        return {
          requestedUrl:
            requested,
          finalUrl:
            current,
          statusCode:
            response.status,
          html: "",
          redirectChain,
          loopDetected:
            false,
          contentType:
            response.headers.get(
              "content-type",
            ),
          error:
            "REDIRECT_WITHOUT_LOCATION",
        };
      }

      const next =
        input.preserveSearch
          ? normalizeSitemapDocumentUrl(
              location,
              current,
              input.allowedHost,
            )
          : normalizeInternalUrl(
              location,
              current,
              input.allowedHost,
            );

      if (!next) {
        return {
          requestedUrl:
            requested,
          finalUrl:
            current,
          statusCode:
            response.status,
          html: "",
          redirectChain,
          loopDetected:
            false,
          contentType:
            response.headers.get(
              "content-type",
            ),
          error:
            "REDIRECT_OUTSIDE_HOST",
        };
      }

      redirectChain.push(
        next,
      );

      if (seen.has(next)) {
        return {
          requestedUrl:
            requested,
          finalUrl:
            next,
          statusCode:
            response.status,
          html: "",
          redirectChain,
          loopDetected:
            true,
          contentType:
            response.headers.get(
              "content-type",
            ),
          error:
            "REDIRECT_LOOP",
        };
      }

      seen.add(next);

      if (hop >= MAX_REDIRECTS) {
        return {
          requestedUrl:
            requested,
          finalUrl:
            next,
          statusCode:
            response.status,
          html: "",
          redirectChain,
          loopDetected:
            false,
          contentType:
            response.headers.get(
              "content-type",
            ),
          error:
            "TOO_MANY_REDIRECTS",
        };
      }

      current =
        next;

      continue;
    }

    const declaredLength =
      response.headers.get(
        "content-length",
      );

    if (declaredLength) {
      const parsedLength =
        Number(
          declaredLength,
        );

      if (
        Number.isFinite(
          parsedLength,
        ) &&
        parsedLength >
          MAX_BODY_BYTES
      ) {
        return {
          requestedUrl:
            requested,
          finalUrl:
            current,
          statusCode:
            response.status,
          html: "",
          redirectChain,
          loopDetected:
            false,
          contentType:
            response.headers.get(
              "content-type",
            ),
          error:
            "BODY_TOO_LARGE",
        };
      }
    }

    const html =
      await response.text();

    if (
      Buffer.byteLength(
        html,
        "utf8",
      ) >
      MAX_BODY_BYTES
    ) {
      return {
        requestedUrl:
          requested,
        finalUrl:
          current,
        statusCode:
          response.status,
        html: "",
        redirectChain,
        loopDetected:
          false,
        contentType:
          response.headers.get(
            "content-type",
          ),
        error:
          "BODY_TOO_LARGE",
      };
    }

    return {
      requestedUrl:
        requested,
      finalUrl:
        current,
      statusCode:
        response.status,
      html,
      redirectChain,
      loopDetected:
        false,
      contentType:
        response.headers.get(
          "content-type",
        ),
      error:
        null,
    };
  }

  throw new Error(
    "REDIRECT_AUDIT_UNREACHABLE",
  );
}

type SitemapInventoryEntry = {
  url: string;
  resourceType:
    SitemapResourceType;
};

async function discoverSitemapInventory(
  input: {
    rootUrl: string;
    allowedHost: string;
    maxDocuments: number;
    maxUrls: number;
    fetchDocument:
      RedirectAuditFetcher;
  },
) {
  const queue:
    string[] = [
      input.rootUrl,
    ];

  const seenDocuments =
    new Set<string>();

  const urlMap =
    new Map<
      string,
      SitemapInventoryEntry
    >();

  let documentsFetched =
    0;

  while (
    queue.length > 0 &&
    documentsFetched <
      input.maxDocuments &&
    urlMap.size <
      input.maxUrls
  ) {
    const next =
      queue.shift();

    if (!next) {
      break;
    }

    if (
      seenDocuments.has(
        next,
      )
    ) {
      continue;
    }

    seenDocuments.add(next);

    const fetched =
      await input.fetchDocument({
        url: next,
        allowedHost:
          input.allowedHost,
        preserveSearch: true,
      });

    documentsFetched += 1;

    if (
      fetched.error ||
      fetched.statusCode < 200 ||
      fetched.statusCode >= 300
    ) {
      throw new Error(
        `REDIRECT_AUDIT_SITEMAP_FETCH_FAILED:${next}:${fetched.statusCode}:${fetched.error ?? ""}`,
      );
    }

    const parsed =
      parseSitemapXml(
        fetched.html,
        fetched.finalUrl,
      );

    if (
      parsed.kind === "INDEX"
    ) {
      for (
        const child
        of parsed.sitemaps
      ) {
        const resolved =
          normalizeSitemapDocumentUrl(
            child.loc,
            fetched.finalUrl,
            input.allowedHost,
          );

        if (
          resolved &&
          !seenDocuments.has(
            resolved,
          )
        ) {
          queue.push(
            resolved,
          );
        }
      }

      continue;
    }

    for (
      const entry
      of parsed.urls
    ) {
      if (
        urlMap.size >=
        input.maxUrls
      ) {
        break;
      }

      const resolved =
        normalizeInternalUrl(
          entry.loc,
          fetched.finalUrl,
          input.allowedHost,
        );

      if (!resolved) {
        continue;
      }

      if (
        !urlMap.has(
          resolved,
        )
      ) {
        urlMap.set(
          resolved,
          {
            url:
              resolved,
            resourceType:
              classifySitemapUrl(
                resolved,
              ),
          },
        );
      }
    }
  }

  return {
    documentsFetched,
    entries:
      Array.from(
        urlMap.values(),
      ),
  };
}

function selectSourcePages(
  entries:
    SitemapInventoryEntry[],
  limit: number,
) {
  if (limit === 0) {
    return [];
  }

  const selected:
    SitemapInventoryEntry[] =
      [];

  const selectedUrls =
    new Set<string>();

  const preferred:
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
    of preferred
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

  for (
    const entry of entries
  ) {
    if (
      selected.length >=
      limit
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

function isHtml(
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
    mediaType ===
      "text/html" ||
    mediaType ===
      "application/xhtml+xml"
  );
}

export async function runRedirectAudit(
  input: {
    primaryDomain: string;
    maxSitemapDocuments?:
      number;
    maxSitemapUrls?:
      number;
    maxSourcePages?:
      number;
    maxLinkChecks?:
      number;
    fetchDocument?:
      RedirectAuditFetcher;
  },
): Promise<
  RedirectAuditResult
> {
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
    clampInteger(
      input.maxSitemapDocuments,
      DEFAULT_MAX_SITEMAP_DOCUMENTS,
      250,
      "REDIRECT_AUDIT_INVALID_SITEMAP_DOCUMENT_LIMIT",
    );

  const maxSitemapUrls =
    clampInteger(
      input.maxSitemapUrls,
      DEFAULT_MAX_SITEMAP_URLS,
      100_000,
      "REDIRECT_AUDIT_INVALID_SITEMAP_URL_LIMIT",
    );

  const maxSourcePages =
    clampInteger(
      input.maxSourcePages,
      DEFAULT_MAX_SOURCE_PAGES,
      MAX_SOURCE_PAGES,
      "REDIRECT_AUDIT_INVALID_SOURCE_LIMIT",
    );

  const maxLinkChecks =
    clampInteger(
      input.maxLinkChecks,
      DEFAULT_MAX_LINK_CHECKS,
      MAX_LINK_CHECKS,
      "REDIRECT_AUDIT_INVALID_LINK_LIMIT",
    );

  const fetchDocument =
    input.fetchDocument ??
    defaultFetchDocument;

  const inventory =
    await discoverSitemapInventory({
      rootUrl:
        rootSitemapUrl,
      allowedHost,
      maxDocuments:
        maxSitemapDocuments,
      maxUrls:
        maxSitemapUrls,
      fetchDocument,
    });

  const candidateUrls =
    inventory.entries.map(
      (entry) =>
        entry.url,
    );

  const sourcePages =
    selectSourcePages(
      inventory.entries,
      maxSourcePages,
    );

  const linkSources =
    new Map<
      string,
      Set<string>
    >();

  const redirectMap =
    new Map<
      string,
      RedirectAuditRedirect
    >();

  const brokenMap =
    new Map<
      string,
      Omit<
        RedirectAuditBrokenLink,
        "suggestion"
      >
    >();

  let sourcePagesSucceeded =
    0;

  let sourcePagesFailed =
    0;

  let clientErrorCount =
    0;

  let serverErrorCount =
    0;

  let internalLinksUnverified =
    0;

  const recordRedirect =
    (
      result:
        RedirectAuditFetchResult,
    ) => {
      if (
        result.redirectChain
          .length === 0 &&
        !result.loopDetected
      ) {
        return;
      }

      redirectMap.set(
        result.requestedUrl,
        {
          requestedUrl:
            result.requestedUrl,
          finalUrl:
            result.finalUrl,
          statusCode:
            result.statusCode,
          redirectChain:
            result.redirectChain,
          hopCount:
            result.redirectChain
              .length,
          loopDetected:
            result.loopDetected,
        },
      );
    };

  const recordBroken =
    (
      url: string,
      statusCode:
        number | null,
      error:
        string | null,
      sourceUrls:
        string[],
      redirectChain:
        string[],
    ) => {
      const existing =
        brokenMap.get(url);

      if (existing) {
        const mergedSources =
          new Set([
            ...existing.sourceUrls,
            ...sourceUrls,
          ]);

        existing.sourceUrls =
          Array.from(
            mergedSources,
          ).slice(0, 10);

        return;
      }

      brokenMap.set(
        url,
        {
          url,
          statusCode,
          error,
          sourceUrls:
            sourceUrls.slice(
              0,
              10,
            ),
          redirectChain,
        },
      );
    };

  const isBrokenFetchResult =
    (
      result:
        RedirectAuditFetchResult,
    ) => {
      return (
        result.statusCode >= 400 ||
        result.loopDetected ||
        (
          result.error !== null &&
          result.error !==
            "BODY_TOO_LARGE"
        )
      );
    };

  for (
    const source
    of sourcePages
  ) {
    let fetched:
      RedirectAuditFetchResult;

    try {
      fetched =
        await fetchDocument({
          url:
            source.url,
          allowedHost,
        });
    } catch {
      sourcePagesFailed +=
        1;

      continue;
    }

    recordRedirect(
      fetched,
    );

    if (
      fetched.statusCode >= 400 &&
      fetched.statusCode < 500
    ) {
      clientErrorCount += 1;
    }

    if (
      fetched.statusCode >= 500
    ) {
      serverErrorCount += 1;
    }

    if (
      fetched.error ===
        "BODY_TOO_LARGE" &&
      fetched.statusCode < 400
    ) {
      sourcePagesFailed +=
        1;

      continue;
    }

    if (
      isBrokenFetchResult(
        fetched,
      )
    ) {
      sourcePagesFailed +=
        1;

      recordBroken(
        source.url,
        fetched.statusCode,
        fetched.error,
        ["SITEMAP"],
        fetched.redirectChain,
      );

      continue;
    }

    if (
      fetched.statusCode < 200 ||
      fetched.statusCode >= 400
    ) {
      sourcePagesFailed +=
        1;

      continue;
    }

    sourcePagesSucceeded +=
      1;

    if (
      !isHtml(
        fetched.contentType,
      )
    ) {
      continue;
    }

    const links =
      extractInternalLinks(
        fetched.html,
        fetched.finalUrl,
        allowedHost,
      );

    for (
      const link of links
    ) {
      let sources =
        linkSources.get(link);

      if (!sources) {
        sources =
          new Set<string>();

        linkSources.set(
          link,
          sources,
        );
      }

      if (
        sources.size < 10
      ) {
        sources.add(
          source.url,
        );
      }
    }
  }

  const linksToCheck =
    Array.from(
      linkSources.keys(),
    ).slice(
      0,
      maxLinkChecks,
    );

  for (
    const link
    of linksToCheck
  ) {
    const sources =
      Array.from(
        linkSources.get(
          link,
        ) ??
        [],
      );

    let fetched:
      RedirectAuditFetchResult;

    try {
      fetched =
        await fetchDocument({
          url: link,
          allowedHost,
        });
    } catch {
      internalLinksUnverified +=
        1;

      continue;
    }

    recordRedirect(
      fetched,
    );

    if (
      fetched.statusCode >= 400 &&
      fetched.statusCode < 500
    ) {
      clientErrorCount += 1;
    }

    if (
      fetched.statusCode >= 500
    ) {
      serverErrorCount += 1;
    }

    if (
      isBrokenFetchResult(
        fetched,
      )
    ) {
      recordBroken(
        link,
        fetched.statusCode,
        fetched.error,
        sources,
        fetched.redirectChain,
      );
    } else if (fetched.error) {
      internalLinksUnverified +=
        1;
    }
  }

  const brokenInternalLinks =
    Array.from(
      brokenMap.values(),
    ).map(
      (broken) => ({
        ...broken,
        suggestion:
          broken.statusCode ===
            404
            ? suggestRedirect(
                broken.url,
                candidateUrls,
              )
            : null,
      }),
    );

  const suggestionCounts = {
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  };

  for (
    const broken
    of brokenInternalLinks
  ) {
    if (
      broken.suggestion
    ) {
      suggestionCounts[
        broken.suggestion
          .confidence
      ] += 1;
    }
  }

  const redirects =
    Array.from(
      redirectMap.values(),
    );

  return {
    rootSitemapUrl,
    primaryHost:
      allowedHost,

    sitemapDocumentsFetched:
      inventory
        .documentsFetched,

    sitemapUrls:
      inventory.entries
        .length,

    sourcePagesRequested:
      sourcePages.length,

    sourcePagesSucceeded,

    sourcePagesFailed,

    internalLinksDiscovered:
      linkSources.size,

    internalLinksChecked:
      linksToCheck.length,

    internalLinksUnverified,

    notFoundCount:
      brokenInternalLinks.filter(
        (item) =>
          item.statusCode ===
          404,
      ).length,

    clientErrorCount,

    serverErrorCount,

    redirectCount:
      redirects.length,

    redirectChainCount:
      redirects.filter(
        (item) =>
          item.hopCount > 1,
      ).length,

    redirectLoopCount:
      redirects.filter(
        (item) =>
          item.loopDetected,
      ).length,

    brokenInternalLinkCount:
      brokenInternalLinks
        .length,

    suggestionCounts,

    redirects:
      redirects.slice(
        0,
        100,
      ),

    brokenInternalLinks:
      brokenInternalLinks
        .slice(
          0,
          100,
        ),
  };
}