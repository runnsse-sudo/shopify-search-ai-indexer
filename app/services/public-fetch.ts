import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type PublicResolver = (
  hostname: string,
) => Promise<readonly { address: string }[]>;
export type PublicFetchDependencies = {
  fetchImpl?: typeof fetch;
  resolve?: PublicResolver;
};
const blocked = new BlockList();
for (const [address, prefix] of [
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
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
// Only global unicast IPv6 is usable here. Also reject special/documentation ranges.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    let canonical: string;
    try {
      canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    } catch {
      return false;
    }
    // Classify the embedded IPv4 explicitly: BlockList IPv4 checks do not parse mapped IPv6.
    if (canonical.startsWith("::ffff:")) {
      const [high, low] = canonical
        .slice(7)
        .split(":")
        .map((part) => parseInt(part, 16));
      const mapped = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
      return !blocked.check(mapped, "ipv4");
    }
  }
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  );
}

export class PublicFetchError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}
const hostName = (value: string) => value.toLowerCase().replace(/\.$/, "");
export function validatePublicTarget(url: URL, allowedHost: string) {
  if (url.protocol !== "https:") throw new PublicFetchError("HTTPS_REQUIRED");
  if (url.username || url.password)
    throw new PublicFetchError("URL_CREDENTIALS_NOT_ALLOWED");
  if (url.port) throw new PublicFetchError("PORT_NOT_ALLOWED");
  const host = hostName(url.hostname);
  if (host !== hostName(allowedHost))
    throw new PublicFetchError("HOST_NOT_ALLOWED");
  if (
    isIP(host.replace(/^\[|\]$/g, "")) ||
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
      host,
    )
  ) {
    throw new PublicFetchError("HOST_NOT_PUBLIC");
  }
  url.hash = "";
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new PublicFetchError("FETCH_TIMEOUT", true));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PublicFetchError("FETCH_TIMEOUT", true));
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function cancel(body: ReadableStream<Uint8Array> | null) {
  // A malicious/hung stream cancellation must not extend our deadline.
  void body?.cancel().catch(() => {});
}

async function boundedText(
  response: Response,
  limit: number,
  controller: AbortController,
) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    cancel(response.body);
    throw new PublicFetchError("BODY_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), controller.signal);
      if (done) break;
      size += value.byteLength; // fetch streams expose decompressed bytes.
      if (size > limit) throw new PublicFetchError("BODY_TOO_LARGE");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } catch (error) {
    controller.abort();
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* cancellation may still settle */
    }
  }
}

export type PublicTextInput = {
  url: string;
  allowedHost: string;
  maxRedirects: number;
  timeoutMs: number;
  maxBodyBytes: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryStatuses?: readonly number[];
  headers?: Record<string, string>;
};

export async function fetchPublicText(
  input: PublicTextInput,
  dependencies: PublicFetchDependencies = {},
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolve =
    dependencies.resolve ??
    ((host) => lookup(host, { all: true, verbatim: true }));
  let current: URL;
  try {
    current = new URL(input.url);
  } catch {
    throw new PublicFetchError("URL_INVALID");
  }
  validatePublicTarget(current, input.allowedHost);
  const requestedUrl = current.href;
  const visited = new Set<string>();
  const redirectChain: string[] = [];
  for (;;) {
    validatePublicTarget(current, input.allowedHost);
    if (visited.has(current.href)) throw new PublicFetchError("REDIRECT_LOOP");
    visited.add(current.href);
    let response!: Response;
    let body = "";
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      let retryDelay: number | null = null;
      try {
        const addresses = await abortable(
          resolve(hostName(current.hostname)),
          controller.signal,
        );
        if (
          !addresses.length ||
          addresses.some(({ address }) => !isPublicAddress(address))
        ) {
          throw new PublicFetchError("NON_PUBLIC_DESTINATION");
        }
        // Prevalidation is NOT connection pinning: native fetch resolves independently.
        const pending = fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: input.headers,
        });
        void pending.then(
          (late) => {
            if (controller.signal.aborted) cancel(late.body);
          },
          () => {},
        );
        response = await abortable(pending, controller.signal);
        const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
        const transient = (input.retryStatuses ?? []).includes(response.status);
        if (transient && attempt < (input.maxRetries ?? 0)) {
          const header = response.headers.get("retry-after");
          const seconds = header === null ? NaN : Number(header);
          const date = header === null ? NaN : Date.parse(header);
          retryDelay = Math.min(
            5000,
            Math.max(
              0,
              Number.isFinite(seconds)
                ? seconds * 1000
                : Number.isFinite(date)
                  ? date - Date.now()
                  : (input.retryBaseDelayMs ?? 0) * 2 ** attempt,
            ),
          );
          cancel(response.body);
        } else if (isRedirect) {
          cancel(response.body);
        } else {
          body = await boundedText(response, input.maxBodyBytes, controller);
        }
      } catch (error) {
        const safe =
          error instanceof PublicFetchError
            ? error
            : new PublicFetchError("FETCH_FAILED", true);
        if (!safe.retryable || attempt >= (input.maxRetries ?? 0)) throw safe;
        retryDelay = Math.min(
          5000,
          (input.retryBaseDelayMs ?? 0) * 2 ** attempt,
        );
      } finally {
        clearTimeout(timer);
        // Cancel stalled I/O, including DNS/fetch after a timed-out race.
        controller.abort();
      }
      if (retryDelay === null) break;
      if (retryDelay > 0)
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, retryDelay),
        );
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return {
        requestedUrl,
        finalUrl: current.href,
        statusCode: response.status,
        body,
        redirectChain,
        xRobotsTag: response.headers.get("x-robots-tag"),
        contentType: response.headers.get("content-type"),
      };
    }
    if (redirectChain.length >= input.maxRedirects)
      throw new PublicFetchError("TOO_MANY_REDIRECTS");
    const location = response.headers.get("location");
    if (!location) throw new PublicFetchError("REDIRECT_WITHOUT_LOCATION");
    try {
      current = new URL(location, current);
    } catch {
      throw new PublicFetchError("REDIRECT_LOCATION_INVALID");
    }
    validatePublicTarget(current, input.allowedHost); // Before DNS or destination fetch.
    redirectChain.push(current.href);
  }
}

// Never relay arbitrary DNS/fetch/body errors, key paths or merchant response text.
export function sanitizeOwnershipError(error: unknown) {
  const safeCodes = new Set([
    "HTTPS_REQUIRED",
    "URL_CREDENTIALS_NOT_ALLOWED",
    "PORT_NOT_ALLOWED",
    "HOST_NOT_ALLOWED",
    "HOST_NOT_PUBLIC",
    "NON_PUBLIC_DESTINATION",
    "BODY_TOO_LARGE",
    "FETCH_TIMEOUT",
    "FETCH_FAILED",
    "URL_INVALID",
    "REDIRECT_LOOP",
    "TOO_MANY_REDIRECTS",
    "REDIRECT_WITHOUT_LOCATION",
    "REDIRECT_LOCATION_INVALID",
    "OWNERSHIP_HTTP_REJECTED",
    "OWNERSHIP_BODY_MISMATCH",
    "PROVIDER_LIFECYCLE_NOT_READY",
  ]);
  return error instanceof PublicFetchError && safeCodes.has(error.code)
    ? error.code
    : "OWNERSHIP_FETCH_REJECTED";
}
