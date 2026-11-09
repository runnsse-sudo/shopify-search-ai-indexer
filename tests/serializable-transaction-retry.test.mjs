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


test("P2034 waits only after rollback, with bounded exponential jitter and unchanged three-attempt ceiling", async () => {
  const events = []; let attempts = 0; const samples = [0, 0.999];
  assert.equal(await runSerializableTransactionWithRetry(async () => {
    events.push("transaction"); attempts++;
    if (attempts < 3) { events.push("rollback"); throw knownRequestError("P2034"); }
    return "committed";
  }, 3, async ms => { events.push(ms); }, () => samples.shift()), "committed");
  assert.deepEqual(events, ["transaction", "rollback", 25, "transaction", "rollback", 99, "transaction"]);
  assert.equal(SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS, 3);
});
test("nonretryable and exhausted errors cause no extra delay or fourth transaction", async () => {
  for (const code of ["P2002", "P2034"]) {
    let calls = 0; const waits = []; const error = knownRequestError(code);
    await assert.rejects(runSerializableTransactionWithRetry(async () => { calls++; throw error; }, 3, async ms => { waits.push(ms); }, () => 0), e => e === error);
    assert.equal(calls, code === "P2034" ? 3 : 1);
    assert.deepEqual(waits, code === "P2034" ? [25, 50] : []);
  }
});
test("invalid retry limits fail before transaction or delay", async () => {
  for (const max of [0, -1, 4, NaN, Infinity, 1.5]) {
    let touched = false;
    await assert.rejects(runSerializableTransactionWithRetry(async () => { touched = true; }, max), /INVALID_SERIALIZABLE_RETRY_LIMIT/);
    assert.equal(touched, false);
  }
});
test("delay failure propagates without starting a replacement transaction", async () => {
  let attempts = 0; const aborted = new Error("SYNTHETIC_WAIT_ABORTED");
  await assert.rejects(runSerializableTransactionWithRetry(async () => { attempts++; throw knownRequestError("P2034"); }, 3, async () => { throw aborted; }, () => 0), e => e === aborted);
  assert.equal(attempts, 1);
});
test("invalid jitter cannot remove the retry delay", async () => {
  for (const sample of [-1, 1, NaN, Infinity]) {
    let attempts = 0;
    await assert.rejects(runSerializableTransactionWithRetry(async () => { attempts++; throw knownRequestError("P2034"); }, 3, async () => {}, () => sample), /INVALID_SERIALIZABLE_RETRY_JITTER/);
    assert.equal(attempts, 1);
  }
});
