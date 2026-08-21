export type IndexNowVerificationMode = "ROOT" | "SCOPED" | "NOT_READY";

export type IndexNowVerificationReason =
  | "READY_ROOT"
  | "READY_SCOPED"
  | "KEY_INVALID"
  | "SUBMITTED_URL_INVALID"
  | "SUBMITTED_URL_NOT_HTTPS"
  | "SUBMITTED_URL_CREDENTIALS_NOT_ALLOWED"
  | "SUBMITTED_URL_FRAGMENT_NOT_ALLOWED"
  | "KEY_LOCATION_INVALID"
  | "KEY_LOCATION_NOT_HTTPS"
  | "KEY_LOCATION_CREDENTIALS_NOT_ALLOWED"
  | "KEY_LOCATION_FRAGMENT_NOT_ALLOWED"
  | "HOST_MISMATCH"
  | "KEY_FILENAME_MISMATCH"
  | "URL_OUTSIDE_KEY_SCOPE";

export type IndexNowVerificationResult = Readonly<{
  ready: boolean;
  mode: IndexNowVerificationMode;
  reason: IndexNowVerificationReason;
  normalizedKeyLocation?: string;
}>;

export type IndexNowVerificationInput = Readonly<{
  submittedUrl: string;
  key: string;
  keyLocation: string;
}>;

export function isValidIndexNowKey(key: string) {
  return /^[A-Za-z0-9-]{8,128}$/.test(key);
}

function notReady(reason: IndexNowVerificationReason): IndexNowVerificationResult {
  return { ready: false, mode: "NOT_READY", reason };
}

function parseUrl(
  value: string,
  invalidReason: IndexNowVerificationReason,
): URL | IndexNowVerificationResult {
  try {
    return new URL(value);
  } catch {
    return notReady(invalidReason);
  }
}

function isFailure(value: URL | IndexNowVerificationResult): value is IndexNowVerificationResult {
  return !(value instanceof URL);
}

export function evaluateIndexNowVerification(
  input: IndexNowVerificationInput,
): IndexNowVerificationResult {
  if (!isValidIndexNowKey(input.key)) return notReady("KEY_INVALID");

  const submittedUrl = parseUrl(input.submittedUrl, "SUBMITTED_URL_INVALID");
  if (isFailure(submittedUrl)) return submittedUrl;
  if (submittedUrl.protocol !== "https:") return notReady("SUBMITTED_URL_NOT_HTTPS");
  if (submittedUrl.username || submittedUrl.password) {
    return notReady("SUBMITTED_URL_CREDENTIALS_NOT_ALLOWED");
  }
  if (submittedUrl.hash) return notReady("SUBMITTED_URL_FRAGMENT_NOT_ALLOWED");

  const keyLocation = parseUrl(input.keyLocation, "KEY_LOCATION_INVALID");
  if (isFailure(keyLocation)) return keyLocation;
  if (keyLocation.protocol !== "https:") return notReady("KEY_LOCATION_NOT_HTTPS");
  if (keyLocation.username || keyLocation.password) {
    return notReady("KEY_LOCATION_CREDENTIALS_NOT_ALLOWED");
  }
  if (keyLocation.hash) return notReady("KEY_LOCATION_FRAGMENT_NOT_ALLOWED");
  if (submittedUrl.host !== keyLocation.host) return notReady("HOST_MISMATCH");

  const filenameStart = keyLocation.pathname.lastIndexOf("/") + 1;
  const filename = keyLocation.pathname.slice(filenameStart);
  if (filename !== `${input.key}.txt`) return notReady("KEY_FILENAME_MISMATCH");

  if (keyLocation.pathname === `/${input.key}.txt`) {
    return {
      ready: true,
      mode: "ROOT",
      reason: "READY_ROOT",
      normalizedKeyLocation: keyLocation.href,
    };
  }

  const scopedDirectory = keyLocation.pathname.slice(0, filenameStart);
  if (!submittedUrl.pathname.startsWith(scopedDirectory)) {
    return notReady("URL_OUTSIDE_KEY_SCOPE");
  }

  return {
    ready: true,
    mode: "SCOPED",
    reason: "READY_SCOPED",
    normalizedKeyLocation: keyLocation.href,
  };
}

export function assertIndexNowReady(input: IndexNowVerificationInput) {
  const result = evaluateIndexNowVerification(input);
  if (!result.ready) {
    throw new Error(`IndexNow ownership verification is not ready: ${result.reason}`);
  }
  return result;
}
