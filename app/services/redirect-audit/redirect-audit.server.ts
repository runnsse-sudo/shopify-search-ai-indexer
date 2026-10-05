import {
  lookup as dnsLookup,
} from "node:dns/promises";
import {
  BlockList,
  isIP,
} from "node:net";

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
  deadlineAt?: number;
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

  sourceConcurrency: number;
  linkConcurrency: number;

  auditDeadlineMs: number;
  retriesPerformed: number;

  timings: {
    sitemapMs: number;
    sourcePagesMs: number;
    linkChecksMs: number;
    totalMs: number;
  };

  coverage: {
    sitemapDocumentsTruncated:
      boolean;
    sitemapUrlsTruncated:
      boolean;
    sourcePagesTruncated:
      boolean;
    internalLinksTruncated:
      boolean;
    auditDeadlineReached:
      boolean;
  };

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

const DEFAULT_SOURCE_CONCURRENCY =
  3;

const MAX_SOURCE_CONCURRENCY =
  6;

const DEFAULT_LINK_CONCURRENCY =
  4;

const MAX_LINK_CONCURRENCY =
  8;

const MAX_REDIRECTS =
  10;

const MAX_BODY_BYTES =
  2 * 1024 * 1024;

const MAX_SITEMAP_BODY_BYTES =
  20 * 1024 * 1024;

const FETCH_TIMEOUT_MS =
  15_000;

const DEFAULT_AUDIT_DEADLINE_MS =
  180_000;

const MAX_AUDIT_DEADLINE_MS =
  240_000;

const MAX_FETCH_ATTEMPTS =
  3;

const RETRY_DELAYS_MS =
  [
    100,
    300,
  ] as const;

const blockedAddresses =
  new BlockList();

for (
  const [
    network,
    prefix,
  ]
  of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const
) {
  blockedAddresses.addSubnet(
    network,
    prefix,
    "ipv4",
  );
}

for (
  const [
    network,
    prefix,
  ]
  of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const
) {
  blockedAddresses.addSubnet(
    network,
    prefix,
    "ipv6",
  );
}


function normalizeHostnameForSecurity(
  value: string,
) {
  let normalized =
    value
      .trim()
      .toLowerCase();

  if (
    normalized.endsWith(
      ".",
    )
  ) {
    normalized =
      normalized.slice(
        0,
        -1,
      );
  }

  if (
    normalized.startsWith(
      "[",
    ) &&
    normalized.endsWith(
      "]",
    )
  ) {
    normalized =
      normalized.slice(
        1,
        -1,
      );
  }

  return normalized;
}


export function isBlockedRedirectAuditAddress(
  address: string,
) {
  const normalized =
    normalizeHostnameForSecurity(
      address,
    );

  const family =
    isIP(
      normalized,
    );

  if (family === 4) {
    return blockedAddresses.check(
      normalized,
      "ipv4",
    );
  }

  if (family === 6) {
    return blockedAddresses.check(
      normalized,
      "ipv6",
    );
  }

  return true;
}


function deadlineReached(
  deadlineAt: number,
) {
  return (
    Date.now() >=
    deadlineAt
  );
}


function createDeadlineResult(
  input:
    RedirectAuditFetchInput,
): RedirectAuditFetchResult {
  return {
    requestedUrl:
      input.url,
    finalUrl:
      input.url,
    statusCode:
      0,
    html: "",
    redirectChain: [],
    loopDetected:
      false,
    contentType:
      null,
    error:
      "AUDIT_DEADLINE_EXCEEDED",
  };
}


async function lookupPublicAddresses(
  hostname: string,
  deadlineAt: number,
) {
  const remaining =
    deadlineAt -
    Date.now();

  if (remaining <= 0) {
    throw new Error(
      "AUDIT_DEADLINE_EXCEEDED",
    );
  }

  let timeout:
    ReturnType<
      typeof setTimeout
    > | null =
      null;

  try {
    return await Promise.race([
      dnsLookup(
        hostname,
        {
          all: true,
          verbatim: true,
        },
      ),

      new Promise<never>(
        (_, reject) => {
          timeout =
            setTimeout(
              () =>
                reject(
                  new Error(
                    "AUDIT_DEADLINE_EXCEEDED",
                  ),
                ),
              remaining,
            );
        },
      ),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(
        timeout,
      );
    }
  }
}


async function assertPublicDnsHost(
  hostname: string,
  deadlineAt: number,
) {
  const normalized =
    normalizeHostnameForSecurity(
      hostname,
    );

  if (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(
      ".localhost",
    )
  ) {
    throw new Error(
      "REDIRECT_AUDIT_PRIVATE_ADDRESS_BLOCKED",
    );
  }

  if (
    isIP(
      normalized,
    ) !== 0
  ) {
    throw new Error(
      "REDIRECT_AUDIT_IP_LITERAL_NOT_ALLOWED",
    );
  }

  const resolved =
    await lookupPublicAddresses(
      normalized,
      deadlineAt,
    );

  if (resolved.length === 0) {
    throw new Error(
      "REDIRECT_AUDIT_DNS_LOOKUP_EMPTY",
    );
  }

  for (
    const entry
    of resolved
  ) {
    if (
      isBlockedRedirectAuditAddress(
        entry.address,
      )
    ) {
      throw new Error(
        "REDIRECT_AUDIT_PRIVATE_ADDRESS_BLOCKED",
      );
    }
  }
}


function clampPositiveInteger(
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
    value < 1
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


function retryableStatus(
  statusCode: number,
) {
  return (
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  );
}


function nonRetryableSecurityError(
  error: unknown,
) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message ===
      "REDIRECT_AUDIT_PRIVATE_ADDRESS_BLOCKED" ||
    error.message ===
      "REDIRECT_AUDIT_IP_LITERAL_NOT_ALLOWED"
  );
}


function isDeadlineError(
  error: unknown,
) {
  return (
    error instanceof Error &&
    error.message ===
      "AUDIT_DEADLINE_EXCEEDED"
  );
}


async function waitForRetry(
  milliseconds: number,
  deadlineAt: number,
) {
  const remaining =
    deadlineAt -
    Date.now();

  if (remaining <= 0) {
    return;
  }

  await new Promise<void>(
    (resolve) =>
      setTimeout(
        resolve,
        Math.min(
          milliseconds,
          remaining,
        ),
      ),
  );
}


async function fetchDocumentWithRetry(
  input: {
    fetchDocument:
      RedirectAuditFetcher;
    request:
      RedirectAuditFetchInput;
    deadlineAt: number;
    onRetry: () => void;
  },
): Promise<
  RedirectAuditFetchResult
> {
  let lastError:
    unknown =
      null;

  for (
    let attempt = 0;
    attempt <
      MAX_FETCH_ATTEMPTS;
    attempt++
  ) {
    if (
      deadlineReached(
        input.deadlineAt,
      )
    ) {
      return createDeadlineResult(
        input.request,
      );
    }

    try {
      const result =
        await input.fetchDocument({
          ...input.request,
          deadlineAt:
            input.deadlineAt,
        });

      if (
        deadlineReached(
          input.deadlineAt,
        )
      ) {
        return createDeadlineResult(
          input.request,
        );
      }

      if (
        result.error ===
        "AUDIT_DEADLINE_EXCEEDED"
      ) {
        return result;
      }

      if (
        retryableStatus(
          result.statusCode,
        ) &&
        attempt <
          MAX_FETCH_ATTEMPTS -
            1
      ) {
        input.onRetry();

        await waitForRetry(
          RETRY_DELAYS_MS[
            attempt
          ] ??
            RETRY_DELAYS_MS[
              RETRY_DELAYS_MS.length -
                1
            ],
          input.deadlineAt,
        );

        continue;
      }

      return result;
    } catch (error) {
      lastError =
        error;

      if (
        deadlineReached(
          input.deadlineAt,
        ) ||
        isDeadlineError(
          error,
        )
      ) {
        return createDeadlineResult(
          input.request,
        );
      }

      if (
        nonRetryableSecurityError(
          error,
        ) ||
        attempt >=
          MAX_FETCH_ATTEMPTS -
            1
      ) {
        throw error;
      }

      input.onRetry();

      await waitForRetry(
        RETRY_DELAYS_MS[
          attempt
        ] ??
          RETRY_DELAYS_MS[
            RETRY_DELAYS_MS.length -
              1
          ],
        input.deadlineAt,
      );
    }
  }

  throw (
    lastError ??
    new Error(
      "REDIRECT_AUDIT_RETRY_UNREACHABLE",
    )
  );
}


async function cancelResponseBody(
  response: Response,
) {
  if (!response.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // Best-effort connection/body cleanup only.
  }
}


async function readResponseTextWithLimit(
  response: Response,
  maximumBytes: number,
): Promise<{
  html: string;
  tooLarge: boolean;
}> {
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
        maximumBytes
    ) {
      await cancelResponseBody(
        response,
      );

      return {
        html: "",
        tooLarge:
          true,
      };
    }
  }

  if (!response.body) {
    const html =
      await response.text();

    return {
      html:
        Buffer.byteLength(
          html,
          "utf8",
        ) >
        maximumBytes
          ? ""
          : html,

      tooLarge:
        Buffer.byteLength(
          html,
          "utf8",
        ) >
        maximumBytes,
    };
  }

  const reader =
    response.body.getReader();

  const chunks:
    Buffer[] = [];

  let totalBytes =
    0;

  try {
    for (;;) {
      const {
        value,
        done,
      } =
        await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      totalBytes +=
        value.byteLength;

      if (
        totalBytes >
        maximumBytes
      ) {
        try {
          await reader.cancel();
        } catch {
          // Best effort.
        }

        return {
          html: "",
          tooLarge:
            true,
        };
      }

      chunks.push(
        Buffer.from(
          value,
        ),
      );
    }
  } finally {
    reader.releaseLock();
  }

  return {
    html:
      Buffer.concat(
        chunks,
        totalBytes,
      ).toString(
        "utf8",
      ),

    tooLarge:
      false,
  };
}


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

function clampConcurrency(
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
    value < 1
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


async function mapWithConcurrency<
  T,
  R
>(
  items: readonly T[],
  concurrency: number,
  worker: (
    item: T,
    index: number,
  ) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results =
    new Array<R>(
      items.length,
    );

  let nextIndex =
    0;

  const runWorker =
    async () => {
      for (;;) {
        const index =
          nextIndex;

        nextIndex +=
          1;

        if (
          index >=
          items.length
        ) {
          return;
        }

        results[index] =
          await worker(
            items[index],
            index,
          );
      }
    };

  const workerCount =
    Math.min(
      concurrency,
      items.length,
    );

  await Promise.all(
    Array.from(
      {
        length:
          workerCount,
      },
      () =>
        runWorker(),
    ),
  );

  return results;
}


function storefrontBase(
  value: string,
) {
  const parsed =
    value.includes("://")
      ? new URL(value)
      : new URL(
          "https://" +
            value,
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

  if (parsed.port) {
    throw new Error(
      "REDIRECT_AUDIT_NON_DEFAULT_PORT_NOT_ALLOWED",
    );
  }

  if (
    isIP(
      normalizeHostnameForSecurity(
        parsed.hostname,
      ),
    ) !== 0
  ) {
    throw new Error(
      "REDIRECT_AUDIT_IP_LITERAL_NOT_ALLOWED",
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

  const deadlineAt =
    input.deadlineAt ??
    (
      Date.now() +
      FETCH_TIMEOUT_MS
    );

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
    if (
      deadlineReached(
        deadlineAt,
      )
    ) {
      return createDeadlineResult({
        ...input,
        url:
          requested,
      });
    }

    const currentUrl =
      new URL(
        current,
      );

    await assertPublicDnsHost(
      currentUrl.hostname,
      deadlineAt,
    );

    const remainingMs =
      deadlineAt -
      Date.now();

    if (remainingMs <= 0) {
      return createDeadlineResult({
        ...input,
        url:
          requested,
      });
    }

    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        Math.max(
          1,
          Math.min(
            FETCH_TIMEOUT_MS,
            remainingMs,
          ),
        ),
      );

    try {
      const response =
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
          await cancelResponseBody(
            response,
          );

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
          await cancelResponseBody(
            response,
          );

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

        await cancelResponseBody(
          response,
        );

        redirectChain.push(
          next,
        );

        if (
          seen.has(
            next,
          )
        ) {
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

        seen.add(
          next,
        );

        if (
          hop >=
          MAX_REDIRECTS
        ) {
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

      const bodyLimit =
        input.preserveSearch
          ? MAX_SITEMAP_BODY_BYTES
          : MAX_BODY_BYTES;

      const body =
        await readResponseTextWithLimit(
          response,
          bodyLimit,
        );

      if (body.tooLarge) {
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
        html:
          body.html,
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
    } finally {
      clearTimeout(
        timer,
      );
    }
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
    deadlineAt: number;
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

  let documentsTruncated =
    false;

  let urlsTruncated =
    false;

  let deadlineWasReached =
    false;

  while (
    queue.length > 0
  ) {
    if (
      deadlineReached(
        input.deadlineAt,
      )
    ) {
      deadlineWasReached =
        true;

      documentsTruncated =
        true;

      break;
    }

    if (
      documentsFetched >=
      input.maxDocuments
    ) {
      documentsTruncated =
        true;

      break;
    }

    if (
      urlMap.size >=
      input.maxUrls
    ) {
      urlsTruncated =
        true;

      break;
    }

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

    seenDocuments.add(
      next,
    );

    const fetched =
      await input.fetchDocument({
        url: next,
        allowedHost:
          input.allowedHost,
        preserveSearch: true,
        deadlineAt:
          input.deadlineAt,
      });

    if (
      fetched.error ===
      "AUDIT_DEADLINE_EXCEEDED"
    ) {
      deadlineWasReached =
        true;

      documentsTruncated =
        true;

      break;
    }

    documentsFetched +=
      1;

    if (
      fetched.error ||
      fetched.statusCode < 200 ||
      fetched.statusCode >= 300
    ) {
      throw new Error(
        "REDIRECT_AUDIT_SITEMAP_FETCH_FAILED:" +
          next +
          ":" +
          fetched.statusCode +
          ":" +
          (
            fetched.error ??
            ""
          ),
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
        urlsTruncated =
          true;

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

  if (
    queue.length > 0 &&
    documentsFetched >=
      input.maxDocuments
  ) {
    documentsTruncated =
      true;
  }

  return {
    documentsFetched,

    entries:
      Array.from(
        urlMap.values(),
      ),

    documentsTruncated,

    urlsTruncated,

    deadlineWasReached,
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
    sourceConcurrency?:
      number;
    linkConcurrency?:
      number;
    maxAuditMs?:
      number;
    fetchDocument?:
      RedirectAuditFetcher;
  },
): Promise<
  RedirectAuditResult
> {
  const totalStartedAt =
    Date.now();

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


  const auditDeadlineMs =
    clampPositiveInteger(
      input.maxAuditMs,
      DEFAULT_AUDIT_DEADLINE_MS,
      MAX_AUDIT_DEADLINE_MS,
      "REDIRECT_AUDIT_INVALID_DEADLINE",
    );

  const deadlineAt =
    totalStartedAt +
    auditDeadlineMs;


  const sourceConcurrency =
    clampConcurrency(
      input.sourceConcurrency,
      DEFAULT_SOURCE_CONCURRENCY,
      MAX_SOURCE_CONCURRENCY,
      "REDIRECT_AUDIT_INVALID_SOURCE_CONCURRENCY",
    );

  const linkConcurrency =
    clampConcurrency(
      input.linkConcurrency,
      DEFAULT_LINK_CONCURRENCY,
      MAX_LINK_CONCURRENCY,
      "REDIRECT_AUDIT_INVALID_LINK_CONCURRENCY",
    );


  const rawFetchDocument =
    input.fetchDocument ??
    defaultFetchDocument;

  let retriesPerformed =
    0;

  const fetchDocument:
    RedirectAuditFetcher =
      async (
        request,
      ) =>
        fetchDocumentWithRetry({
          fetchDocument:
            rawFetchDocument,
          request,
          deadlineAt,
          onRetry: () => {
            retriesPerformed +=
              1;
          },
        });


  // --------------------------------------------------------
  // PHASE 1 — SITEMAP INVENTORY
  //
  // Sequential by design.
  // --------------------------------------------------------

  const sitemapStartedAt =
    Date.now();

  const inventory =
    await discoverSitemapInventory({
      rootUrl:
        rootSitemapUrl,
      allowedHost,
      maxDocuments:
        maxSitemapDocuments,
      maxUrls:
        maxSitemapUrls,
      deadlineAt,
      fetchDocument,
    });

  let auditDeadlineReached =
    inventory.deadlineWasReached;

  const sitemapMs =
    Date.now() -
    sitemapStartedAt;


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


  let sourcePagesTruncated =
    inventory.entries.length >
    sourcePages.length;


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
        brokenMap.get(
          url,
        );

      if (existing) {
        const mergedSources =
          new Set([
            ...existing.sourceUrls,
            ...sourceUrls,
          ]);

        existing.sourceUrls =
          Array.from(
            mergedSources,
          ).slice(
            0,
            10,
          );

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
            "BODY_TOO_LARGE" &&
          result.error !==
            "AUDIT_DEADLINE_EXCEEDED"
        )
      );
    };


  // --------------------------------------------------------
  // PHASE 2 — SOURCE PAGES
  //
  // Fetches concurrent, processing deterministic.
  // --------------------------------------------------------

  const sourcePagesStartedAt =
    Date.now();


  const sourceOutcomes =
    await mapWithConcurrency(
      sourcePages,
      sourceConcurrency,
      async (
        source,
      ) => {
        try {
          const fetched =
            await fetchDocument({
              url:
                source.url,
              allowedHost,
            });

          return {
            source,
            fetched,
            threw:
              false,
          };
        } catch {
          return {
            source,
            fetched:
              null,
            threw:
              true,
          };
        }
      },
    );


  for (
    const outcome
    of sourceOutcomes
  ) {
    const {
      source,
      fetched,
      threw,
    } =
      outcome;

    if (
      threw ||
      !fetched
    ) {
      sourcePagesFailed +=
        1;

      continue;
    }


    if (
      fetched.error ===
      "AUDIT_DEADLINE_EXCEEDED"
    ) {
      auditDeadlineReached =
        true;

      sourcePagesTruncated =
        true;

      continue;
    }


    recordRedirect(
      fetched,
    );


    if (
      fetched.statusCode >= 400 &&
      fetched.statusCode < 500
    ) {
      clientErrorCount +=
        1;
    }


    if (
      fetched.statusCode >= 500
    ) {
      serverErrorCount +=
        1;
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
        [
          "SITEMAP",
        ],
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
      const link
      of links
    ) {
      let sources =
        linkSources.get(
          link,
        );

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


  const sourcePagesMs =
    Date.now() -
    sourcePagesStartedAt;


  // --------------------------------------------------------
  // PHASE 3 — INTERNAL LINKS
  //
  // Fetches concurrent, processing deterministic.
  // --------------------------------------------------------

  const linksToCheck =
    Array.from(
      linkSources.keys(),
    ).slice(
      0,
      maxLinkChecks,
    );


  let internalLinksTruncated =
    linkSources.size >
    linksToCheck.length;


  const linkChecksStartedAt =
    Date.now();


  const linkOutcomes =
    await mapWithConcurrency(
      linksToCheck,
      linkConcurrency,
      async (
        link,
      ) => {
        const sources =
          Array.from(
            linkSources.get(
              link,
            ) ??
            [],
          );

        try {
          const fetched =
            await fetchDocument({
              url:
                link,
              allowedHost,
            });

          return {
            link,
            sources,
            fetched,
            threw:
              false,
          };
        } catch {
          return {
            link,
            sources,
            fetched:
              null,
            threw:
              true,
          };
        }
      },
    );


  for (
    const outcome
    of linkOutcomes
  ) {
    const {
      link,
      sources,
      fetched,
      threw,
    } =
      outcome;

    if (
      threw ||
      !fetched
    ) {
      internalLinksUnverified +=
        1;

      continue;
    }


    if (
      fetched.error ===
      "AUDIT_DEADLINE_EXCEEDED"
    ) {
      auditDeadlineReached =
        true;

      internalLinksTruncated =
        true;

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
      clientErrorCount +=
        1;
    }


    if (
      fetched.statusCode >= 500
    ) {
      serverErrorCount +=
        1;
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
    } else if (
      fetched.error
    ) {
      internalLinksUnverified +=
        1;
    }
  }


  const linkChecksMs =
    Date.now() -
    linkChecksStartedAt;


  // --------------------------------------------------------
  // FINAL DETERMINISTIC ANALYSIS
  // --------------------------------------------------------

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
      ] +=
        1;
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

    sourceConcurrency,

    linkConcurrency,

    auditDeadlineMs,

    retriesPerformed,

    timings: {
      sitemapMs,
      sourcePagesMs,
      linkChecksMs,

      totalMs:
        Date.now() -
        totalStartedAt,
    },

    coverage: {
      sitemapDocumentsTruncated:
        inventory
          .documentsTruncated,

      sitemapUrlsTruncated:
        inventory
          .urlsTruncated,

      sourcePagesTruncated,

      internalLinksTruncated,

      auditDeadlineReached,
    },

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
