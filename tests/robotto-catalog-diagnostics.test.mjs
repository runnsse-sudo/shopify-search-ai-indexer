import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CatalogVerificationError,
  robottoCatalogFailure,
} from "../app/services/llm-visibility/robotto-catalog-diagnostics.ts";

test("preserves every internal catalog failure code without exporting error properties", async () => {
  const paths = [
    "llm-catalog.server.ts",
    "robotto-catalog-publication.server.ts",
    "robotto-catalog-storage.server.ts",
  ];
  for (const path of paths) {
    const source = await readFile(
      new URL("../app/services/llm-visibility/" + path, import.meta.url),
      "utf8",
    );
    for (const [, code] of source.matchAll(/new Error\("([A-Z_]+)"\)/g)) {
      const error = new Error(code, { cause: "private token" });
      error.token = "secret";
      assert.deepEqual(robottoCatalogFailure(error, "catalog"), {
        status: "REVIEW_REQUIRED",
        code,
        phase: "catalog",
      });
    }
  }
});

test("unknown provider errors, stack traces and injected codes remain private", () => {
  for (const value of [
    new Error("https://private-host/?token=secret"),
    new Error("CATALOG_EXPORT_LIMIT\nprivate data"),
    Object.assign(new Error("private database detail"), {
      code: "CATALOG_READ_FAILED",
    }),
    { message: "CATALOG_READ_FAILED", token: "secret" },
    null,
  ]) {
    assert.deepEqual(robottoCatalogFailure(value, "session"), {
      status: "REVIEW_REQUIRED",
      code: "CATALOG_UNEXPECTED_ERROR",
      phase: "session",
    });
  }
});

test("known lock and configuration errors stay distinct from provider failures", () => {
  assert.equal(
    robottoCatalogFailure(new Error("CATALOG_PUBLICATION_LOCKED"), "lock").code,
    "CATALOG_PUBLICATION_LOCKED",
  );
  assert.equal(
    robottoCatalogFailure(
      new Error("ROBOTTO_CATALOG_NOT_ENABLED"),
      "configuration",
    ).code,
    "ROBOTTO_CATALOG_NOT_ENABLED",
  );
  assert.deepEqual(
    robottoCatalogFailure(
      Object.assign(new Error("private connection string"), { code: "P1001" }),
      "session",
    ),
    {
      status: "REVIEW_REQUIRED",
      code: "P1001",
      phase: "session",
    },
  );
  assert.equal(
    robottoCatalogFailure(
      new DOMException("private URL", "TimeoutError"),
      "catalog",
    ).code,
    "CATALOG_TIMEOUT",
  );
});

test("verification diagnostics preserve only bounded hashes/version/time, including original cause", () => {
  const evidence = {
    observedAt: "2026-11-09T17:00:45.000Z",
    canonicalSha256: "a".repeat(64),
    downloadSha256: "b".repeat(64),
    canonicalBytes: 100,
    downloadBytes: 99,
    beforeVersion: "123",
    afterVersion: "123",
    token: "SECRET",
  };
  const original = new CatalogVerificationError(
    "PUBLIC_CDN_HASH_MISMATCH",
    evidence,
  );
  const result = robottoCatalogFailure(
    new Error("PUBLICATION_UNCONFIRMED", { cause: original }),
    "public_verify",
  );
  assert.equal(result.code, "PUBLICATION_UNCONFIRMED");
  assert.equal(result.causeCode, "PUBLIC_CDN_HASH_MISMATCH");
  assert.equal(result.verification.canonicalSha256, evidence.canonicalSha256);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  for (const [key, value] of [
    ["beforeVersion", "https://secret"],
    ["canonicalSha256", "secret"],
    ["canonicalBytes", -1],
    ["observedAt", "secret"],
  ]) {
    assert.equal(
      robottoCatalogFailure(
        new CatalogVerificationError("PUBLIC_CDN_HASH_MISMATCH", {
          ...evidence,
          [key]: value,
        }),
        "public_verify",
      ).verification,
      undefined,
    );
  }
  assert.equal(
    robottoCatalogFailure(
      Object.assign(new Error("PUBLIC_CDN_HASH_MISMATCH"), { evidence }),
      "public_verify",
    ).verification,
    undefined,
  );
});
