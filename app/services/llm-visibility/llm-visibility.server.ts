import {
  lookup as dnsLookup,
} from "node:dns/promises";

import {
  BlockList,
  isIP,
} from "node:net";

import {
  runSitemapAudit,
  type SitemapAuditResult,
} from "../sitemap/sitemap-audit.server";

import {
  AI_CRAWLERS,
  analyzeLlmsDocument,
  buildLlmsFullTxtPreview,
  buildLlmsTxtPreview,
  calculateLlmVisibilityScore,
  evaluateRobotsAccess,
  parseRobotsTxt,
  type LlmsDocumentAnalysis,
  type ParsedRobotsTxt,
} from "./llm-visibility";


export type LlmVisibilityFetchInput = {
  url: string;
  allowedHost: string;
  maxBodyBytes: number;
};


export type LlmVisibilityFetchResult = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  body: string;
  redirectChain: string[];
  contentType: string | null;
  xRobotsTag: string | null;
};


export type LlmVisibilityFetcher = (
  input:
    LlmVisibilityFetchInput,
) => Promise<
  LlmVisibilityFetchResult
>;


export type LlmVisibilityRecommendation = {
  code: string;

  severity:
    | "INFO"
    | "MEDIUM"
    | "HIGH";

  message: string;
};


export type LlmVisibilityAuditResult = {
  primaryHost: string;

  score: number;

  scoreLabel: string;

  scoreNote: string;

  representativePaths:
    string[];

  robots: {
    url: string;

    statusCode:
      number | null;

    finalUrl:
      string | null;

    contentType:
      string | null;

    redirectCount:
      number;

    error:
      string | null;

    groupCount:
      number;

    sitemapCount:
      number;

    sitemaps:
      string[];
  };

  llmsTxt: {
    url: string;

    statusCode:
      number | null;

    finalUrl:
      string | null;

    contentType:
      string | null;

    redirectCount:
      number;

    error:
      string | null;

    analysis:
      LlmsDocumentAnalysis |
      null;
  };

  llmsFullTxt: {
    url: string;

    statusCode:
      number | null;

    finalUrl:
      string | null;

    contentType:
      string | null;

    redirectCount:
      number;

    error:
      string | null;

    analysis:
      LlmsDocumentAnalysis |
      null;
  };

  crawlers:
    Array<{
      token: string;

      vendor: string;

      purpose: string;

      searchVisibilityRelevant:
        boolean;

      explicitGroup:
        boolean;

      wildcardFallback:
        boolean;

      rootAccess:
        | "ALLOW"
        | "DISALLOW"
        | "UNKNOWN";

      allRepresentativePathsAllowed:
        boolean;

      paths:
        Array<{
          path: string;

          access:
            | "ALLOW"
            | "DISALLOW"
            | "UNKNOWN";
        }>;
    }>;

  sitemap: {
    rootSitemapUrl:
      string;

    documentsFetched:
      number;

    totalUrls:
      number;

    sampledPages:
      number;

    sampledNoindex:
      number;

    sampledCanonicalMismatch:
      number;

    sampledFetchFailures:
      number;
  };

  previews: {
    llmsTxt: string;
    llmsFullTxt: string;
  };

  recommendations:
    LlmVisibilityRecommendation[];

  timings: {
    documentFetchMs:
      number;

    sitemapAuditMs:
      number;

    totalMs:
      number;
  };
};


const REPRESENTATIVE_PATHS = [
  "/",
  "/products/",
  "/collections/",
  "/pages/",
  "/blogs/",
] as const;


const ROBOTS_BODY_LIMIT =
  1024 * 1024;

const LLMS_BODY_LIMIT =
  2 * 1024 * 1024;

const FETCH_TIMEOUT_MS =
  15_000;

const DNS_TIMEOUT_MS =
  5_000;

const MAX_REDIRECTS =
  5;

const MAX_ATTEMPTS =
  2;

const RETRY_DELAY_MS =
  250;


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


function normalizeHost(
  value: string,
) {
  return value
    .trim()
    .toLowerCase()
    .replace(
      /\.$/,
      "",
    );
}


function storefrontBase(
  value: string,
) {
  const parsed =
    value.includes(
      "://",
    )
      ? new URL(
          value,
        )
      : new URL(
          `https://${value}`,
        );


  if (
    parsed.protocol !==
    "https:"
  ) {
    throw new Error(
      "LLM_VISIBILITY_HTTPS_REQUIRED",
    );
  }


  if (
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "LLM_VISIBILITY_CREDENTIALS_NOT_ALLOWED",
    );
  }


  if (
    parsed.port
  ) {
    throw new Error(
      "LLM_VISIBILITY_NON_DEFAULT_PORT_NOT_ALLOWED",
    );
  }


  if (
    isIP(
      parsed.hostname,
    ) !== 0
  ) {
    throw new Error(
      "LLM_VISIBILITY_IP_LITERAL_NOT_ALLOWED",
    );
  }


  parsed.pathname =
    "/";

  parsed.search =
    "";

  parsed.hash =
    "";


  return parsed;
}


function validateSameHostTarget(
  value: URL,
  allowedHost: string,
) {
  if (
    value.protocol !==
    "https:"
  ) {
    throw new Error(
      "LLM_VISIBILITY_HTTPS_REQUIRED",
    );
  }


  if (
    value.username ||
    value.password
  ) {
    throw new Error(
      "LLM_VISIBILITY_CREDENTIALS_NOT_ALLOWED",
    );
  }


  if (
    value.port
  ) {
    throw new Error(
      "LLM_VISIBILITY_NON_DEFAULT_PORT_NOT_ALLOWED",
    );
  }


  if (
    normalizeHost(
      value.hostname,
    ) !==
    normalizeHost(
      allowedHost,
    )
  ) {
    throw new Error(
      "LLM_VISIBILITY_HOST_NOT_ALLOWED",
    );
  }


  if (
    isIP(
      value.hostname,
    ) !== 0
  ) {
    throw new Error(
      "LLM_VISIBILITY_IP_LITERAL_NOT_ALLOWED",
    );
  }
}


function isBlockedAddress(
  address: string,
) {
  const family =
    isIP(
      address,
    );


  if (
    family ===
    4
  ) {
    return blockedAddresses.check(
      address,
      "ipv4",
    );
  }


  if (
    family ===
    6
  ) {
    return blockedAddresses.check(
      address,
      "ipv6",
    );
  }


  return true;
}


async function assertPublicDnsHost(
  hostname: string,
) {
  const normalized =
    normalizeHost(
      hostname,
    );


  if (
    !normalized ||
    normalized ===
      "localhost" ||
    normalized.endsWith(
      ".localhost",
    )
  ) {
    throw new Error(
      "LLM_VISIBILITY_PRIVATE_ADDRESS_BLOCKED",
    );
  }


  let timer:
    ReturnType<
      typeof setTimeout
    > | null =
      null;


  try {
    const resolved =
      await Promise.race([
        dnsLookup(
          normalized,
          {
            all: true,
            verbatim: true,
          },
        ),

        new Promise<never>(
          (
            _,
            reject,
          ) => {
            timer =
              setTimeout(
                () =>
                  reject(
                    new Error(
                      "LLM_VISIBILITY_DNS_TIMEOUT",
                    ),
                  ),
                DNS_TIMEOUT_MS,
              );
          },
        ),
      ]);


    if (
      resolved.length ===
      0
    ) {
      throw new Error(
        "LLM_VISIBILITY_DNS_EMPTY",
      );
    }


    for (
      const entry
      of resolved
    ) {
      if (
        isBlockedAddress(
          entry.address,
        )
      ) {
        throw new Error(
          "LLM_VISIBILITY_PRIVATE_ADDRESS_BLOCKED",
        );
      }
    }
  } finally {
    if (timer) {
      clearTimeout(
        timer,
      );
    }
  }
}


function isRedirectStatus(
  status: number,
) {
  return [
    301,
    302,
    303,
    307,
    308,
  ].includes(
    status,
  );
}


function isRetryableStatus(
  status: number,
) {
  return [
    408,
    429,
    500,
    502,
    503,
    504,
  ].includes(
    status,
  );
}


async function cancelBody(
  response: Response,
) {
  try {
    await response.body
      ?.cancel();
  } catch {
    // Best-effort response cleanup only.
  }
}


async function readTextWithLimit(
  response: Response,
  maximumBytes: number,
) {
  const declared =
    response.headers.get(
      "content-length",
    );


  if (declared) {
    const parsed =
      Number(
        declared,
      );


    if (
      Number.isFinite(
        parsed,
      ) &&
      parsed >
        maximumBytes
    ) {
      await cancelBody(
        response,
      );

      throw new Error(
        "LLM_VISIBILITY_BODY_TOO_LARGE",
      );
    }
  }


  if (
    !response.body
  ) {
    const text =
      await response.text();


    if (
      new TextEncoder()
        .encode(
          text,
        )
        .byteLength >
      maximumBytes
    ) {
      throw new Error(
        "LLM_VISIBILITY_BODY_TOO_LARGE",
      );
    }


    return text;
  }


  const reader =
    response.body
      .getReader();


  const chunks:
    Uint8Array[] = [];


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

        throw new Error(
          "LLM_VISIBILITY_BODY_TOO_LARGE",
        );
      }


      chunks.push(
        value,
      );
    }
  } finally {
    reader.releaseLock();
  }


  const combined =
    new Uint8Array(
      totalBytes,
    );


  let offset =
    0;


  for (
    const chunk
    of chunks
  ) {
    combined.set(
      chunk,
      offset,
    );

    offset +=
      chunk.byteLength;
  }


  return new TextDecoder()
    .decode(
      combined,
    );
}


async function waitRetry() {
  await new Promise<void>(
    (resolve) =>
      setTimeout(
        resolve,
        RETRY_DELAY_MS,
      ),
  );
}


async function defaultTextFetcher(
  input:
    LlmVisibilityFetchInput,
): Promise<
  LlmVisibilityFetchResult
> {
  const requested =
    new URL(
      input.url,
    );


  validateSameHostTarget(
    requested,
    input.allowedHost,
  );


  let current =
    requested;


  const redirectChain:
    string[] = [];


  const seen =
    new Set<string>([
      current.toString(),
    ]);


  for (
    let hop = 0;
    hop <=
      MAX_REDIRECTS;
    hop++
  ) {
    validateSameHostTarget(
      current,
      input.allowedHost,
    );


    await assertPublicDnsHost(
      current.hostname,
    );


    let response:
      Response | null =
        null;


    for (
      let attempt = 0;
      attempt <
        MAX_ATTEMPTS;
      attempt++
    ) {
      const controller =
        new AbortController();


      const timer =
        setTimeout(
          () =>
            controller.abort(),
          FETCH_TIMEOUT_MS,
        );


      try {
        response =
          await fetch(
            current,
            {
              method:
                "GET",

              redirect:
                "manual",

              signal:
                controller.signal,

              headers: {
                accept:
                  "text/plain,text/markdown,text/html,application/xhtml+xml,*/*;q=0.5",

                "user-agent":
                  "Runn-Search-AI-Indexer-LLM-Visibility/1.0 (+read-only audit)",
              },
            },
          );


        if (
          isRetryableStatus(
            response.status,
          ) &&
          attempt <
            MAX_ATTEMPTS -
              1
        ) {
          await cancelBody(
            response,
          );

          response =
            null;

          await waitRetry();

          continue;
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
            throw new Error(
              "LLM_VISIBILITY_REDIRECT_WITHOUT_LOCATION",
            );
          }


          if (
            hop >=
            MAX_REDIRECTS
          ) {
            throw new Error(
              "LLM_VISIBILITY_TOO_MANY_REDIRECTS",
            );
          }


          const next =
            new URL(
              location,
              current,
            );


          validateSameHostTarget(
            next,
            input.allowedHost,
          );


          await cancelBody(
            response,
          );


          const nextUrl =
            next.toString();


          if (
            seen.has(
              nextUrl,
            )
          ) {
            throw new Error(
              "LLM_VISIBILITY_REDIRECT_LOOP",
            );
          }


          seen.add(
            nextUrl,
          );

          redirectChain.push(
            nextUrl,
          );


          current =
            next;

          response =
            null;

          break;
        }


        const body =
          await readTextWithLimit(
            response,
            input.maxBodyBytes,
          );


        return {
          requestedUrl:
            requested.toString(),

          finalUrl:
            current.toString(),

          statusCode:
            response.status,

          body,

          redirectChain,

          contentType:
            response.headers.get(
              "content-type",
            ),

          xRobotsTag:
            response.headers.get(
              "x-robots-tag",
            ),
        };
      } catch (error) {
        if (
          attempt >=
          MAX_ATTEMPTS -
            1
        ) {
          throw error;
        }


        await waitRetry();
      } finally {
        clearTimeout(
          timer,
        );
      }
    }


    if (response) {
      throw new Error(
        "LLM_VISIBILITY_FETCH_STATE_INVALID",
      );
    }
  }


  throw new Error(
    "LLM_VISIBILITY_UNREACHABLE_REDIRECT_STATE",
  );
}


function resourceErrorResult(
  url: string,
  error: unknown,
) {
  return {
    requestedUrl:
      url,

    finalUrl:
      null,

    statusCode:
      null,

    body:
      "",

    redirectChain:
      [] as string[],

    contentType:
      null,

    xRobotsTag:
      null,

    error:
      error instanceof Error
        ? error.message
        : "LLM_VISIBILITY_FETCH_FAILED",
  };
}


async function fetchOptionalResource(
  input:
    LlmVisibilityFetchInput,

  fetchText:
    LlmVisibilityFetcher,
) {
  try {
    const fetched =
      await fetchText(
        input,
      );


    return {
      ...fetched,

      error:
        null,
    };
  } catch (error) {
    return resourceErrorResult(
      input.url,
      error,
    );
  }
}


function effectiveRobotsAccess(
  statusCode:
    number | null,

  parsed:
    ParsedRobotsTxt |
    null,

  crawlerToken:
    string,

  path:
    string,
):
  | "ALLOW"
  | "DISALLOW"
  | "UNKNOWN" {
  if (
    statusCode ===
      200 &&
    parsed
  ) {
    return evaluateRobotsAccess(
      parsed,
      crawlerToken,
      path,
    );
  }


  if (
    statusCode ===
      404 ||
    statusCode ===
      410
  ) {
    return "ALLOW";
  }


  return "UNKNOWN";
}


function scoreLabel(
  score: number,
) {
  if (
    score >= 85
  ) {
    return "STRONG";
  }

  if (
    score >= 65
  ) {
    return "GOOD";
  }

  if (
    score >= 40
  ) {
    return "PARTIAL";
  }

  return "LIMITED";
}


function resourceSummary(
  resource:
    Awaited<
      ReturnType<
        typeof fetchOptionalResource
      >
    >,
) {
  return {
    url:
      resource.requestedUrl,

    statusCode:
      resource.statusCode,

    finalUrl:
      resource.finalUrl,

    contentType:
      resource.contentType,

    redirectCount:
      resource
        .redirectChain
        .length,

    error:
      resource.error,
  };
}


type SitemapRunner = (
  input: {
    primaryDomain: string;
    maxPageChecks?: number;
  },
) => Promise<
  SitemapAuditResult
>;


async function runSecureSitemapAudit(
  input: {
    primaryDomain: string;
    maxPageChecks?: number;
  },
) {
  return runSitemapAudit({
    primaryDomain:
      input.primaryDomain,

    maxPageChecks:
      input.maxPageChecks,

    fetchXml:
      async (
        request,
      ) => {
        const fetched =
          await defaultTextFetcher({
            url:
              request.url,

            allowedHost:
              request.allowedHost,

            maxBodyBytes:
              20 *
              1024 *
              1024,
          });


        return {
          requestedUrl:
            fetched
              .requestedUrl,

          finalUrl:
            fetched.finalUrl,

          statusCode:
            fetched.statusCode,

          body:
            fetched.body,

          redirectChain:
            fetched
              .redirectChain,

          contentType:
            fetched.contentType,
        };
      },

    fetchPage:
      async (
        request,
      ) => {
        const fetched =
          await defaultTextFetcher({
            url:
              request.url,

            allowedHost:
              request.allowedHost,

            maxBodyBytes:
              request.maxBodyBytes ??
              5 *
                1024 *
                1024,
          });


        return {
          requestedUrl:
            fetched
              .requestedUrl,

          finalUrl:
            fetched.finalUrl,

          statusCode:
            fetched.statusCode,

          html:
            fetched.body,

          redirectChain:
            fetched
              .redirectChain,

          xRobotsTag:
            fetched
              .xRobotsTag,

          contentType:
            fetched.contentType,
        };
      },
  });
}


export async function runLlmVisibilityAudit(
  input: {
    primaryDomain: string;

    fetchText?:
      LlmVisibilityFetcher;

    sitemapRunner?:
      SitemapRunner;
  },
): Promise<
  LlmVisibilityAuditResult
> {
  const totalStartedAt =
    Date.now();


  const base =
    storefrontBase(
      input.primaryDomain,
    );


  const allowedHost =
    base.hostname;


  const robotsUrl =
    new URL(
      "/robots.txt",
      base,
    ).toString();


  const llmsTxtUrl =
    new URL(
      "/llms.txt",
      base,
    ).toString();


  const llmsFullTxtUrl =
    new URL(
      "/llms-full.txt",
      base,
    ).toString();


  const fetchText =
    input.fetchText ??
    defaultTextFetcher;


  const sitemapRunner =
    input.sitemapRunner ??
    runSecureSitemapAudit;


  const documentPromise =
    (
      async () => {
        const startedAt =
          Date.now();


        const resources =
          await Promise.all([
            fetchOptionalResource(
              {
                url:
                  robotsUrl,

                allowedHost,

                maxBodyBytes:
                  ROBOTS_BODY_LIMIT,
              },
              fetchText,
            ),

            fetchOptionalResource(
              {
                url:
                  llmsTxtUrl,

                allowedHost,

                maxBodyBytes:
                  LLMS_BODY_LIMIT,
              },
              fetchText,
            ),

            fetchOptionalResource(
              {
                url:
                  llmsFullTxtUrl,

                allowedHost,

                maxBodyBytes:
                  LLMS_BODY_LIMIT,
              },
              fetchText,
            ),
          ]);


        return {
          resources,

          elapsedMs:
            Date.now() -
            startedAt,
        };
      }
    )();


  const sitemapPromise =
    (
      async () => {
        const startedAt =
          Date.now();


        const audit =
          await sitemapRunner({
            primaryDomain:
              input.primaryDomain,

            maxPageChecks:
              8,
          });


        return {
          audit,

          elapsedMs:
            Date.now() -
            startedAt,
        };
      }
    )();


  const [
    documentPhase,
    sitemapPhase,
  ] =
    await Promise.all([
      documentPromise,
      sitemapPromise,
    ]);


  const documentResources =
    documentPhase.resources;


  const sitemapAudit =
    sitemapPhase.audit;


  const documentFetchMs =
    documentPhase.elapsedMs;


  const sitemapAuditMs =
    sitemapPhase.elapsedMs;


  const [
    robotsResource,
    llmsResource,
    llmsFullResource,
  ] =
    documentResources;


  const parsedRobots =
    robotsResource
      .statusCode ===
      200
      ? parseRobotsTxt(
          robotsResource.body,
        )
      : null;


  const crawlerResults =
    AI_CRAWLERS.map(
      (
        crawler,
      ) => {
        const paths =
          REPRESENTATIVE_PATHS.map(
            (
              path,
            ) => ({
              path,

              access:
                effectiveRobotsAccess(
                  robotsResource
                    .statusCode,

                  parsedRobots,

                  crawler.token,

                  path,
                ),
            }),
          );


        const explicitGroup =
          Boolean(
            parsedRobots
              ?.groups.some(
                (
                  group,
                ) =>
                  group.userAgents
                    .includes(
                      crawler.token
                        .toLowerCase(),
                    ),
              ),
          );


        const wildcardFallback =
          Boolean(
            parsedRobots &&
            !explicitGroup &&
            parsedRobots
              .groups.some(
                (
                  group,
                ) =>
                  group.userAgents
                    .includes(
                      "*",
                    ),
              ),
          );


        return {
          token:
            crawler.token,

          vendor:
            crawler.vendor,

          purpose:
            crawler.purpose,

          searchVisibilityRelevant:
            crawler
              .searchVisibilityRelevant,

          explicitGroup,

          wildcardFallback,

          rootAccess:
            paths[0]
              ?.access ??
            "UNKNOWN",

          allRepresentativePathsAllowed:
            paths.every(
              (
                entry,
              ) =>
                entry.access ===
                "ALLOW",
            ),

          paths,
        };
      },
    );


  const llmsAnalysis =
    llmsResource
      .statusCode ===
      200
      ? analyzeLlmsDocument(
          llmsResource.body,
        )
      : null;


  const llmsFullAnalysis =
    llmsFullResource
      .statusCode ===
      200
      ? analyzeLlmsDocument(
          llmsFullResource.body,
        )
      : null;


  const llmsTxtPresent =
    Boolean(
      llmsAnalysis
        ?.nonEmpty,
    );


  const llmsFullTxtPresent =
    Boolean(
      llmsFullAnalysis
        ?.nonEmpty,
    );


  const searchCrawlerAccess =
    crawlerResults
      .filter(
        (
          crawler,
        ) =>
          crawler
            .searchVisibilityRelevant,
      )
      .map(
        (
          crawler,
        ) => ({
          token:
            crawler.token,

          allRepresentativePathsAllowed:
            crawler
              .allRepresentativePathsAllowed,

          rootAllowed:
            crawler.rootAccess ===
            "ALLOW",
        }),
      );


  const score =
    calculateLlmVisibilityScore({
      robotsStatusCode:
        robotsResource
          .statusCode,

      searchCrawlerAccess,

      robotsSitemapCount:
        parsedRobots
          ?.sitemaps.length ??
        0,

      llmsTxtPresent,

      llmsFullTxtPresent,

      sampledNoindex:
        sitemapAudit
          .pageChecks
          .noindex,

      sampledCanonicalMismatch:
        sitemapAudit
          .pageChecks
          .canonicalMismatch,
    });


  const recommendations:
    LlmVisibilityRecommendation[] =
      [];


  if (
    robotsResource.error ||
    ![
      200,
      404,
      410,
    ].includes(
      robotsResource
        .statusCode ??
      -1,
    )
  ) {
    recommendations.push({
      code:
        "ROBOTS_UNVERIFIED",

      severity:
        "HIGH",

      message:
        "robots.txt could not be reliably evaluated.",
    });
  }


  for (
    const crawler
    of crawlerResults.filter(
      (
        entry,
      ) =>
        entry
          .searchVisibilityRelevant,
    )
  ) {
    const codeToken =
      crawler.token
        .toUpperCase()
        .replace(
          /[^A-Z0-9]+/g,
          "_",
        );


    if (
      crawler.rootAccess ===
      "UNKNOWN"
    ) {
      recommendations.push({
        code:
          `${codeToken}_UNKNOWN`,

        severity:
          "HIGH",

        message:
          `${crawler.token} visibility could not be determined from robots.txt.`,
      });

      continue;
    }


    if (
      crawler.rootAccess ===
      "DISALLOW"
    ) {
      recommendations.push({
        code:
          `${codeToken}_BLOCKED`,

        severity:
          "HIGH",

        message:
          `${crawler.token} is blocked from the storefront root by robots.txt.`,
      });

      continue;
    }


    if (
      !crawler
        .allRepresentativePathsAllowed
    ) {
      recommendations.push({
        code:
          `${codeToken}_PARTIAL`,

        severity:
          "MEDIUM",

        message:
          `${crawler.token} is allowed at the root but blocked from one or more representative storefront paths.`,
      });
    }
  }


  if (
    !llmsTxtPresent
  ) {
    recommendations.push({
      code:
        "LLMS_TXT_MISSING",

      severity:
        "INFO",

      message:
        "No non-empty /llms.txt was detected. This audit treats llms.txt as an optional discovery convention, not a robots control.",
    });
  }


  if (
    !llmsFullTxtPresent
  ) {
    recommendations.push({
      code:
        "LLMS_FULL_TXT_MISSING",

      severity:
        "INFO",

      message:
        "No non-empty /llms-full.txt was detected. The generated preview remains read-only and unpublished.",
    });
  }


  if (
    (
      parsedRobots
        ?.sitemaps.length ??
      0
    ) === 0
  ) {
    recommendations.push({
      code:
        "ROBOTS_SITEMAP_NOT_DECLARED",

      severity:
        "MEDIUM",

      message:
        "robots.txt does not declare a Sitemap directive.",
    });
  }


  if (
    sitemapAudit
      .pageChecks
      .noindex >
    0
  ) {
    recommendations.push({
      code:
        "SAMPLED_NOINDEX",

      severity:
        "HIGH",

      message:
        `${sitemapAudit.pageChecks.noindex} checked sitemap page(s) exposed noindex.`,
    });
  }


  if (
    sitemapAudit
      .pageChecks
      .canonicalMismatch >
    0
  ) {
    recommendations.push({
      code:
        "SAMPLED_CANONICAL_MISMATCH",

      severity:
        "HIGH",

      message:
        `${sitemapAudit.pageChecks.canonicalMismatch} checked sitemap page(s) canonicalized elsewhere.`,
    });
  }


  const previewInput = {
    primaryHost:
      allowedHost,

    sitemapUrl:
      sitemapAudit
        .rootSitemapUrl,

    sampleUrls:
      sitemapAudit
        .sampleUrls
        .map(
          (
            entry,
          ) => ({
            url:
              entry.url,

            resourceType:
              entry.resourceType,
          }),
        ),
  };


  return {
    primaryHost:
      allowedHost,

    score,

    scoreLabel:
      scoreLabel(
        score,
      ),

    scoreNote:
      "Heuristic technical readiness score only. Training-crawler opt-in or opt-out does not reduce this score.",

    representativePaths:
      [
        ...REPRESENTATIVE_PATHS,
      ],

    robots: {
      ...resourceSummary(
        robotsResource,
      ),

      groupCount:
        parsedRobots
          ?.groups.length ??
        0,

      sitemapCount:
        parsedRobots
          ?.sitemaps.length ??
        0,

      sitemaps:
        parsedRobots
          ?.sitemaps ??
        [],
    },

    llmsTxt: {
      ...resourceSummary(
        llmsResource,
      ),

      analysis:
        llmsAnalysis,
    },

    llmsFullTxt: {
      ...resourceSummary(
        llmsFullResource,
      ),

      analysis:
        llmsFullAnalysis,
    },

    crawlers:
      crawlerResults,

    sitemap: {
      rootSitemapUrl:
        sitemapAudit
          .rootSitemapUrl,

      documentsFetched:
        sitemapAudit
          .sitemapDocumentsFetched,

      totalUrls:
        sitemapAudit
          .totalUrls,

      sampledPages:
        sitemapAudit
          .pageChecks
          .requested,

      sampledNoindex:
        sitemapAudit
          .pageChecks
          .noindex,

      sampledCanonicalMismatch:
        sitemapAudit
          .pageChecks
          .canonicalMismatch,

      sampledFetchFailures:
        sitemapAudit
          .pageChecks
          .failed,
    },

    previews: {
      llmsTxt:
        buildLlmsTxtPreview(
          previewInput,
        ),

      llmsFullTxt:
        buildLlmsFullTxtPreview(
          previewInput,
        ),
    },

    recommendations,

    timings: {
      documentFetchMs,

      sitemapAuditMs,

      totalMs:
        Date.now() -
        totalStartedAt,
    },
  };
}