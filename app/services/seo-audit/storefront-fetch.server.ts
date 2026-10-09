import { fetchPublicText, PublicFetchError, type PublicFetchDependencies } from "../public-fetch.ts";

export type StorefrontFetchResult = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  html: string;
  redirectChain: string[];
  xRobotsTag: string | null;
  contentType: string | null;
};

export type StorefrontFetchInput = {
  url: string;
  allowedHost: string;
  maxRedirects?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES =
  5 * 1024 * 1024;

const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES_LIMIT = 3;

const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_BASE_DELAY_MS = 5_000;

export async function fetchStorefrontPage(
  input: StorefrontFetchInput,
  dependencies: PublicFetchDependencies = {},
): Promise<StorefrontFetchResult> {
  const maxRedirects =
    input.maxRedirects ??
    DEFAULT_MAX_REDIRECTS;

  const timeoutMs =
    input.timeoutMs ??
    DEFAULT_TIMEOUT_MS;

  const maxBodyBytes =
    input.maxBodyBytes ??
    DEFAULT_MAX_BODY_BYTES;

  const maxRetries =
    input.maxRetries ??
    DEFAULT_MAX_RETRIES;

  const retryBaseDelayMs =
    input.retryBaseDelayMs ??
    DEFAULT_RETRY_BASE_DELAY_MS;

  if (
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 10
  ) {
    throw new Error(
      "SEO_AUDIT_INVALID_MAX_REDIRECTS",
    );
  }

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 60_000
  ) {
    throw new Error(
      "SEO_AUDIT_INVALID_TIMEOUT",
    );
  }

  if (
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes < 1_024 ||
    maxBodyBytes >
      20 * 1024 * 1024
  ) {
    throw new Error(
      "SEO_AUDIT_INVALID_BODY_LIMIT",
    );
  }

  if (
    !Number.isInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > MAX_RETRIES_LIMIT
  ) {
    throw new Error(
      "SEO_AUDIT_INVALID_MAX_RETRIES",
    );
  }

  if (
    !Number.isInteger(
      retryBaseDelayMs,
    ) ||
    retryBaseDelayMs < 0 ||
    retryBaseDelayMs >
      MAX_RETRY_BASE_DELAY_MS
  ) {
    throw new Error(
      "SEO_AUDIT_INVALID_RETRY_DELAY",
    );
  }

  try {
    const fetched = await fetchPublicText({
      url: input.url, allowedHost: input.allowedHost, maxRedirects, timeoutMs, maxBodyBytes,
      maxRetries, retryBaseDelayMs, retryStatuses: [408, 429, 500, 502, 503, 504],
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Runn-Search-AI-Indexer-SEO-Audit/1.0 (+read-only storefront audit)" },
    }, dependencies);
    const { body, ...result } = fetched;
    return { ...result, html: body };
  } catch (error) {
    throw new Error("SEO_AUDIT_" + (error instanceof PublicFetchError ? error.code : "FETCH_FAILED"));
  }
}
