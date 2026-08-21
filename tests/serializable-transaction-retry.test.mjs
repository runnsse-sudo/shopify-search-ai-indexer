import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  isSerializableTransactionConflict,
  runSerializableTransactionWithRetry,
  SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS,
} from "../app/services/serializable-transaction-retry.server.ts";

function knownRequestError(code) {
  return new Prisma.PrismaClientKnownRequestError(`Prisma ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });
}

test("successful Serializable transaction returns without retry", async () => {
  let attempts = 0;
  const result = await runSerializableTransactionWithRetry(async () => {
    attempts += 1;
    return "processed";
  });
  assert.equal(result, "processed");
  assert.equal(attempts, 1);
});

test("one P2034 retries and succeeds on the second transaction attempt", async () => {
  let attempts = 0;
  const result = await runSerializableTransactionWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw knownRequestError("P2034");
    return "processed";
  });
  assert.equal(result, "processed");
  assert.equal(attempts, 2);
});

test("two P2034 errors retry and succeed on the third transaction attempt", async () => {
  let attempts = 0;
  const result = await runSerializableTransactionWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw knownRequestError("P2034");
    return "processed";
  });
  assert.equal(result, "processed");
  assert.equal(attempts, 3);
  assert.equal(SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS, 3);
});

test("an exhausted P2034 propagates the final Prisma error", async () => {
  let attempts = 0;
  const errors = Array.from({ length: 3 }, () => knownRequestError("P2034"));
  await assert.rejects(
    runSerializableTransactionWithRetry(async () => {
      const error = errors[attempts];
      attempts += 1;
      throw error;
    }),
    (error) => error === errors[2],
  );
  assert.equal(attempts, 3);
});

test("a non-P2034 Prisma error propagates without retry", async () => {
  let attempts = 0;
  const error = knownRequestError("P2002");
  await assert.rejects(
    runSerializableTransactionWithRetry(async () => {
      attempts += 1;
      throw error;
    }),
    (received) => received === error,
  );
  assert.equal(attempts, 1);
});

test("an arbitrary object carrying code P2034 is not retried", async () => {
  let attempts = 0;
  const error = { code: "P2034" };
  assert.equal(isSerializableTransactionConflict(error), false);
  await assert.rejects(
    runSerializableTransactionWithRetry(async () => {
      attempts += 1;
      throw error;
    }),
    (received) => received === error,
  );
  assert.equal(attempts, 1);
});

test("the complete transaction callback is re-executed on retry", async () => {
  const callbackRuns = [];
  await runSerializableTransactionWithRetry(async () => {
    callbackRuns.push(`transaction-${callbackRuns.length + 1}`);
    if (callbackRuns.length === 1) throw knownRequestError("P2034");
    return "processed";
  });
  assert.deepEqual(callbackRuns, ["transaction-1", "transaction-2"]);
});

test("a duplicate webhook result after retry passes through normally", async () => {
  let attempts = 0;
  const duplicate = { duplicateWebhook: true, changed: false, queued: false };
  const result = await runSerializableTransactionWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw knownRequestError("P2034");
    return duplicate;
  });
  assert.equal(result, duplicate);
  assert.equal(attempts, 2);
});
