import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { isValidIndexNowKey } from "./indexnow-verification.ts";
import { fetchPublicText, PublicFetchError, sanitizeOwnershipError, type PublicFetchDependencies } from "./public-fetch.ts";

export async function fetchIndexNowOwnershipFile(
  input: { key: string; keyLocation: string; allowedHost: string },
  dependencies: PublicFetchDependencies = {},
) {
  try {
    validateIndexNowCredentialPayload({ version: 1, key: input.key, keyLocation: input.keyLocation }, input.allowedHost);
    const response = await fetchPublicText({
      url: input.keyLocation, allowedHost: input.allowedHost, maxRedirects: 5,
      timeoutMs: 10_000, maxBodyBytes: 1024, headers: { accept: "text/plain,*/*;q=0.1" },
    }, dependencies);
    if (response.statusCode < 200 || response.statusCode >= 300) throw new PublicFetchError("OWNERSHIP_HTTP_REJECTED");
    if (response.body.replace(/^\uFEFF/, "").trim() !== input.key) throw new PublicFetchError("OWNERSHIP_BODY_MISMATCH");
    return { verified: true };
  } catch (error) {
    // The key appears in the pathname; never expose arbitrary transport errors.
    throw new PublicFetchError(sanitizeOwnershipError(error));
  }
}

export type IndexNowCredentialPayload =
  Readonly<{
    version: 1;
    key: string;
    keyLocation: string;
  }>;

export type IndexNowShopReadinessInput =
  Readonly<{
    enabled: boolean;
    primaryDomain:
      string | null | undefined;
    allowedHost:
      string | null | undefined;
    credentialCiphertext:
      string | null | undefined;
    credentialIv:
      string | null | undefined;
    credentialTag:
      string | null | undefined;
    ownershipVerifiedAt:
      Date | null | undefined;
  }>;

export function normalizeIndexNowHost(
  value: string,
) {
  const normalized =
    value.trim().toLowerCase();

  if (
    !normalized ||
    normalized.includes("://") ||
    normalized.includes("/") ||
    normalized.includes("@")
  ) {
    throw new Error(
      "IndexNow host is invalid",
    );
  }

  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    isIP(normalized) !== 0
  ) {
    throw new Error(
      "IndexNow host must be a public hostname",
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(
      `https://${normalized}`,
    );
  } catch {
    throw new Error(
      "IndexNow host is invalid",
    );
  }

  if (
    parsed.hostname !== normalized ||
    parsed.port ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "IndexNow host is invalid",
    );
  }

  return normalized;
}

export function generateIndexNowKey() {
  return randomBytes(16).toString("hex");
}

export function buildIndexNowRootKeyLocation(
  host: string,
  key: string,
) {
  const normalizedHost =
    normalizeIndexNowHost(host);

  if (!isValidIndexNowKey(key)) {
    throw new Error(
      "IndexNow key is invalid",
    );
  }

  return `https://${normalizedHost}/${key}.txt`;
}

export function validateIndexNowCredentialPayload(
  payload: IndexNowCredentialPayload,
  allowedHost: string,
) {
  const normalizedHost =
    normalizeIndexNowHost(
      allowedHost,
    );

  if (
    payload.version !== 1 ||
    !isValidIndexNowKey(payload.key)
  ) {
    throw new Error(
      "IndexNow credential payload is invalid",
    );
  }

  let location: URL;

  try {
    location = new URL(
      payload.keyLocation,
    );
  } catch {
    throw new Error(
      "IndexNow key location is invalid",
    );
  }

  if (
    location.protocol !== "https:" ||
    location.username ||
    location.password ||
    location.hash ||
    location.host !== normalizedHost ||
    location.pathname !==
      `/${payload.key}.txt`
  ) {
    throw new Error(
      "IndexNow key location must be the verified HTTPS root key location",
    );
  }

  return {
    ...payload,
    keyLocation:
      location.href,
    allowedHost:
      normalizedHost,
  } as const;
}

export function validateIndexNowOwnershipResponseUrl(
  value: string,
  allowedHost: string,
) {
  const normalizedHost =
    normalizeIndexNowHost(
      allowedHost,
    );

  let finalUrl: URL;

  try {
    finalUrl =
      new URL(value);
  } catch {
    throw new Error(
      "IndexNow ownership response URL is invalid",
    );
  }

  if (
    finalUrl.protocol !== "https:" ||
    finalUrl.username ||
    finalUrl.password ||
    finalUrl.hash ||
    finalUrl.host !== normalizedHost
  ) {
    throw new Error(
      "IndexNow ownership verification redirected outside the verified shop host",
    );
  }

  return finalUrl.href;
}

export function indexNowShopReadinessReason(
  input: IndexNowShopReadinessInput,
) {
  if (!input.enabled) {
    return "INDEXNOW_DISABLED";
  }

  if (
    !input.primaryDomain ||
    !input.allowedHost
  ) {
    return "DOMAIN_NOT_CONFIGURED";
  }

  let primaryDomain: string;
  let allowedHost: string;

  try {
    primaryDomain =
      normalizeIndexNowHost(
        input.primaryDomain,
      );

    allowedHost =
      normalizeIndexNowHost(
        input.allowedHost,
      );
  } catch {
    return "DOMAIN_INVALID";
  }

  if (primaryDomain !== allowedHost) {
    return "PRIMARY_DOMAIN_CHANGED";
  }

  if (
    !input.credentialCiphertext ||
    !input.credentialIv ||
    !input.credentialTag
  ) {
    return "CREDENTIALS_NOT_CONFIGURED";
  }

  if (!input.ownershipVerifiedAt) {
    return "OWNERSHIP_NOT_VERIFIED";
  }

  return null;
}
