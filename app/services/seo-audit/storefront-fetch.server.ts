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
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

function normalizeHost(host: string) {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function validateTarget(
  url: URL,
  allowedHost: string,
) {
  if (url.protocol !== "https:") {
    throw new Error(
      "SEO_AUDIT_HTTPS_REQUIRED",
    );
  }

  if (
    normalizeHost(url.hostname) !==
    normalizeHost(allowedHost)
  ) {
    throw new Error(
      "SEO_AUDIT_HOST_NOT_ALLOWED",
    );
  }

  if (url.username || url.password) {
    throw new Error(
      "SEO_AUDIT_URL_CREDENTIALS_NOT_ALLOWED",
    );
  }
}

function isRedirectStatus(status: number) {
  return [301, 302, 303, 307, 308].includes(status);
}

export async function fetchStorefrontPage(
  input: StorefrontFetchInput,
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
    maxBodyBytes > 20 * 1024 * 1024
  ) {
    throw new Error(
      "SEO_AUDIT_INVALID_BODY_LIMIT",
    );
  }

  const requested = new URL(input.url);

  validateTarget(
    requested,
    input.allowedHost,
  );

  let current = requested;

  const redirectChain: string[] = [];

  for (
    let hop = 0;
    hop <= maxRedirects;
    hop += 1
  ) {
    validateTarget(
      current,
      input.allowedHost,
    );

    const controller =
      new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

    let response: Response;

    try {
      response = await fetch(
        current,
        {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept:
              "text/html,application/xhtml+xml",
            "user-agent":
              "Runn-Search-AI-Indexer-SEO-Audit/1.0 (+read-only storefront audit)",
          },
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (isRedirectStatus(response.status)) {
      const location =
        response.headers.get("location");

      if (!location) {
        throw new Error(
          "SEO_AUDIT_REDIRECT_WITHOUT_LOCATION",
        );
      }

      if (hop >= maxRedirects) {
        throw new Error(
          "SEO_AUDIT_TOO_MANY_REDIRECTS",
        );
      }

      const next =
        new URL(location, current);

      validateTarget(
        next,
        input.allowedHost,
      );

      redirectChain.push(
        next.toString(),
      );

      current = next;
      continue;
    }

    const declaredLength =
      response.headers.get(
        "content-length",
      );

    if (declaredLength) {
      const parsed =
        Number(declaredLength);

      if (
        Number.isFinite(parsed) &&
        parsed > maxBodyBytes
      ) {
        throw new Error(
          "SEO_AUDIT_BODY_TOO_LARGE",
        );
      }
    }

    const html =
      await response.text();

    if (
      Buffer.byteLength(
        html,
        "utf8",
      ) > maxBodyBytes
    ) {
      throw new Error(
        "SEO_AUDIT_BODY_TOO_LARGE",
      );
    }

    return {
      requestedUrl:
        requested.toString(),

      finalUrl:
        current.toString(),

      statusCode:
        response.status,

      html,

      redirectChain,

      xRobotsTag:
        response.headers.get(
          "x-robots-tag",
        ),

      contentType:
        response.headers.get(
          "content-type",
        ),
    };
  }

  throw new Error(
    "SEO_AUDIT_UNREACHABLE_REDIRECT_STATE",
  );
}