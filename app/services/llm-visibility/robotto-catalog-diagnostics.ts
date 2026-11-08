const safeCodes = new Set([
  "CATALOG_WORKER_NOT_ENABLED", "INVALID_CATALOG_TARGET", "INVALID_CATALOG_TARGETS",
  "CATALOG_TARGET_COLLISION", "CATALOG_SESSION_MISMATCH", "CATALOG_TENANT_MISMATCH",
  "CATALOG_STATE_TARGET_DRIFT", "CATALOG_CLOCK_DRIFT", "CATALOG_STATE_UNVERIFIED",
  "CATALOG_LOCK_REQUIRED", "CATALOG_COUNT_UNVERIFIED", "CATALOG_INCOMPLETE",
  "INVALID_CATALOG_CATALOG", "INVALID_CATALOG_PRODUCT_LINK",
  "ROBOTTO_CATALOG_NOT_ENABLED", "INVALID_ROBOTTO_SESSION", "INVALID_CATALOG_BUCKET",
  "CATALOG_STORAGE_AUTH_FAILED", "CATALOG_STORAGE_METADATA_FAILED",
  "CATALOG_STORAGE_IDENTITY_MISMATCH", "CATALOG_PUBLICATION_LOCKED",
  "CATALOG_LOCK_RELEASE_UNCONFIRMED", "INVALID_CATALOG_BACKUP",
  "CATALOG_BACKUP_READ_FAILED", "CATALOG_BACKUP_SIZE_MISMATCH", "PERSISTED_BACKUP_MISMATCH",
  "INVALID_ROBOTTO_CATALOG", "INVALID_ROBOTTO_PRODUCT_LINK", "PUBLIC_READ_FAILED",
  "PUBLIC_FILE_TOO_LARGE", "INVALID_PILOT_TARGET", "ROBOTTO_CATALOG_COUNT_UNVERIFIED",
  "ROBOTTO_CATALOG_INCOMPLETE", "INVALID_PILOT_MANIFEST", "PILOT_HASH_MISMATCH",
  "INVALID_CATALOG_OR_BACKUP", "SHOPIFY_HTTP_FAILED", "SHOPIFY_GRAPHQL_FAILED",
  "SHOP_OR_FILE_MISMATCH", "WRITE_FILES_NOT_GRANTED", "SHOPIFY_FILE_URL_MISMATCH",
  "STAGING_REJECTED", "STAGING_TARGET_MISMATCH", "STAGING_UPLOAD_FAILED",
  "FILE_UPDATE_REJECTED", "PUBLIC_HASH_NOT_VERIFIED", "FILE_NOT_READY",
  "PUBLIC_BASELINE_DRIFT", "STAGING_SOURCE_COLLISION", "PUBLICATION_UNCONFIRMED",
  "CATALOG_EXPORT_LIMIT", "CATALOG_READ_FAILED", "CATALOG_CURSOR_INVALID",
  "CATALOG_PUBLICATION_MISMATCH", "CATALOG_URL_MISMATCH", "CATALOG_DUPLICATE_URL",
]);

export type CatalogPhase = "configuration" | "initialization" | "lock" | "session" | "catalog" | "disconnect"
  | "checkpoint_read" | "catalog_count" | "catalog_generate" | "file_metadata"
  | "public_read" | "public_verify" | "compare_links" | "backup" | "stage"
  | "upload" | "file_update" | "checkpoint_write" | "lock_release";

const safeProviderCodes = new Set([
  "EACCES", "EEXIST", "ENOENT", "ENOSPC", "EROFS", "ETIMEDOUT", "ECONNRESET",
  "P1000", "P1001", "P1002", "P1010", "P1011", "P1017", "P2021", "P2022", "P2024",
]);

function safeCode(error: unknown) {
  let code = "CATALOG_UNEXPECTED_ERROR";
  if (error instanceof Error) {
    const providerCode = (error as Error & { code?: unknown }).code;
    if (safeCodes.has(error.message)) code = error.message;
    else if (typeof providerCode === "string" && safeProviderCodes.has(providerCode)) code = providerCode;
    else if (error.name === "TimeoutError") code = "CATALOG_TIMEOUT";
  }
  return code;
}

export function robottoCatalogFailure(error: unknown, phase: CatalogPhase) {
  const code = safeCode(error);
  const causeCode = error instanceof Error ? safeCode(error.cause) : "CATALOG_UNEXPECTED_ERROR";
  return {
    status: "REVIEW_REQUIRED", code, phase,
    ...(causeCode !== "CATALOG_UNEXPECTED_ERROR" && { causeCode }),
  } as const;
}
