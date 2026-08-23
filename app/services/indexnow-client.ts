import { evaluateIndexNowVerification } from "./indexnow-verification.ts";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_RESULT_TEXT_LIMIT = 2000;

export type PreparedIndexNowRequest = Readonly<{
  url: string;
  host: string;
  key: string;
  keyLocation: string;
}>;

export type IndexNowClientResult = Readonly<{
  successful: boolean;
  retryable: boolean;
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
}>;

function boundedSanitizedText(value: unknown, key: string) {
  return String(value ?? "")
    .split(key).join("[REDACTED]")
    .slice(0, INDEXNOW_RESULT_TEXT_LIMIT);
}

export function sanitizeIndexNowResult(result: IndexNowClientResult, key: string): IndexNowClientResult {
  return {
    ...result,
    responseBody: result.responseBody === null ? null : boundedSanitizedText(result.responseBody, key),
    error: result.error === null ? null : boundedSanitizedText(result.error, key),
  };
}

export function prepareIndexNowRequest(input: {
  url: string;
  key: string;
  keyLocation: string;
}): PreparedIndexNowRequest {
  const readiness = evaluateIndexNowVerification({
    submittedUrl: input.url,
    key: input.key,
    keyLocation: input.keyLocation,
  });
  if (!readiness.ready || readiness.mode !== "ROOT") {
    throw new Error(`IndexNow execution readiness rejected: ${readiness.reason}`);
  }
  return {
    url: input.url,
    host: new URL(input.url).host,
    key: input.key,
    keyLocation: readiness.normalizedKeyLocation ?? input.keyLocation,
  };
}

export async function sendPreparedIndexNowRequest(
  request: PreparedIndexNowRequest,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<IndexNowClientResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: request.host,
        key: request.key,
        keyLocation: request.keyLocation,
        urlList: [request.url],
      }),
      signal: controller.signal,
    });
    const responseBody = boundedSanitizedText(await response.text(), request.key) || null;
    if (response.status === 200 || response.status === 202) {
      return { successful: true, retryable: false, responseCode: response.status, responseBody, error: null };
    }
    const retryable = response.status === 429 || response.status >= 500;
    return {
      successful: false,
      retryable,
      responseCode: response.status,
      responseBody,
      error: `IndexNow returned HTTP ${response.status}`,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      successful: false,
      retryable: true,
      responseCode: null,
      responseBody: null,
      error: boundedSanitizedText(
        timedOut ? "IndexNow request timed out" : `IndexNow network failure: ${error instanceof Error ? error.message : "unknown error"}`,
        request.key,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function submitIndexNowUrl(
  input: { url: string; key: string; keyLocation: string },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
) {
  return sendPreparedIndexNowRequest(prepareIndexNowRequest(input), options);
}
