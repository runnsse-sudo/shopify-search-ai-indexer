import assert from "node:assert/strict";
import test from "node:test";
import {
  revokeProviderLifecycleWithClient,
  isIndexNowLifecycleReadyWithClient,
  listInstalledIndexNowConfigsWithClient,
} from "../app/services/provider-lifecycle.ts";
import { executeOneIndexNowItem } from "../app/services/indexnow-executor.server.ts";

const domain = "tenant.myshopify.com";
const host = "store.example";
const token = new Date("2026-10-08T10:00:00Z");
const item = {
  id: "queue1",
  shopId: "shop1",
  provider: "INDEXNOW",
  action: "INDEX",
  status: "PROCESSING",
  claimedAt: token,
  url: `https://${host}/products/one`,
  retryCount: 0,
};
function database(installed = true) {
  const config = {
    shopId: "shop1",
    indexNowEnabled: true,
    indexNowAllowedHost: host,
    indexNowCredentialCiphertext: "synthetic",
    indexNowCredentialIv: "synthetic",
    indexNowCredentialTag: "synthetic",
    indexNowOwnershipVerifiedAt: token,
    shop: { id: "shop1", domain, primaryDomain: host },
  };
  const other = {
    ...config,
    shopId: "shop2",
    shop: { id: "shop2", domain: "other.myshopify.com", primaryDomain: host },
  };
  const rows = [
    { ...item, status: "PENDING", dedupeKey: "pending-key" },
    { ...item, id: "processing" },
    {
      ...item,
      id: "internal",
      provider: "INTERNAL",
      status: "PENDING",
      dedupeKey: "internal-key",
    },
    { ...item, id: "complete", status: "COMPLETED" },
    { ...item, id: "other", shopId: "shop2", status: "PENDING" },
  ];
  const sessions = new Set(
    installed ? [domain, other.shop.domain] : [other.shop.domain],
  );
  const selection = [];
  const client = {
    shop: {
      findUnique: async ({ where }) =>
        where.domain === domain ? { id: "shop1" } : null,
    },
    session: {
      findFirst: async ({ where, select }) => {
        assert.deepEqual(select, { id: true });
        assert.equal(where.isOnline, false);
        return sessions.has(where.shop)
          ? { id: `offline_${where.shop}` }
          : null;
      },
      deleteMany: async ({ where }) => {
        sessions.delete(where.shop);
      },
    },
    shopProviderConfig: {
      findUnique: async ({ where }) =>
        where.shopId === "shop1" ? config : other,
      findMany: async (input) => {
        selection.push(input);
        return [config, other].filter(
          (row) =>
            row.indexNowEnabled === input.where.indexNowEnabled &&
            row.indexNowOwnershipVerifiedAt !== null,
        );
      },
      updateMany: async ({ where, data }) => {
        assert.equal(where.shopId, "shop1");
        Object.assign(config, data);
        return { count: 1 };
      },
    },
    indexQueueItem: {
      updateMany: async ({ where, data }) => {
        for (const row of rows)
          if (
            row.shopId === where.shopId &&
            row.provider === where.provider &&
            where.status.in.includes(row.status)
          )
            Object.assign(row, data);
      },
    },
  };
  return { client, config, other, sessions, rows, selection };
}

for (const authenticatedSession of [{ id: `offline_${domain}` }, undefined]) {
  test(`uninstall revokes enabled/verified config even webhook session ${authenticatedSession ? "present" : "absent"}`, async () => {
    const h = database();
    // Webhook authentication supplies shop independently of optional session.
    const authenticated = { shop: domain, session: authenticatedSession };
    await revokeProviderLifecycleWithClient(h.client, authenticated.shop);
    assert.equal(h.config.indexNowEnabled, false);
    assert.equal(h.config.indexNowOwnershipVerifiedAt, null);
    assert.equal(
      await isIndexNowLifecycleReadyWithClient(h.client, "shop1"),
      false,
    );
    assert.equal(h.sessions.has(domain), false);
    assert.equal(h.other.indexNowEnabled, true);
    assert.equal(h.sessions.has(h.other.shop.domain), true);
  });
}
test("repeated uninstall is idempotent; INTERNAL/history preserved, provider pending/processing cancelled", async () => {
  const h = database();
  await revokeProviderLifecycleWithClient(h.client, domain);
  const first = structuredClone(h.rows);
  await revokeProviderLifecycleWithClient(h.client, domain);
  assert.deepEqual(h.rows, first);
  for (const row of h.rows.slice(0, 2)) {
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.dedupeKey, null);
    assert.equal(row.claimedAt, null);
  }
  assert.equal(h.rows[2].provider, "INTERNAL");
  assert.equal(h.rows[2].status, "PENDING");
  assert.equal(h.rows[2].dedupeKey, "internal-key");
  assert.equal(h.rows[3].status, "COMPLETED");
  assert.equal(h.rows[4].status, "PENDING");
});
for (const lastRun of ["materializationLastRunAt", "indexNowLastRunAt"]) {
  test(`${lastRun} ready selector excludes missing offline installation despite enabled verified leftovers`, async () => {
    const h = database(false);
    const result = await listInstalledIndexNowConfigsWithClient(
      h.client,
      10,
      lastRun,
    );
    assert.deepEqual(
      result.map((row) => row.shopId),
      ["shop2"],
    );
    assert.deepEqual(h.selection[0].orderBy, [
      { [lastRun]: { sort: "asc", nulls: "first" } },
      { shopId: "asc" },
    ]);
    assert.equal(
      await isIndexNowLifecycleReadyWithClient(h.client, "shop1"),
      false,
    );
  });
}
test("reinstall/session recreation alone cannot restore revoked provider state", async () => {
  const h = database();
  await revokeProviderLifecycleWithClient(h.client, domain);
  h.sessions.add(domain);
  assert.equal(
    await isIndexNowLifecycleReadyWithClient(h.client, "shop1"),
    false,
  );
  assert.deepEqual(
    (
      await listInstalledIndexNowConfigsWithClient(
        h.client,
        10,
        "indexNowLastRunAt",
      )
    ).map((row) => row.shopId),
    ["shop2"],
  );
});
test("late lifecycle guard stops pre-uninstall queued work after stale ready selection, zero HTTP/attempts", async () => {
  const h = database();
  assert.equal(
    (
      await listInstalledIndexNowConfigsWithClient(
        h.client,
        10,
        "indexNowLastRunAt",
      )
    )[0].shopId,
    "shop1",
  );
  let http = 0,
    attempts = 0;
  const failures = [];
  const dependencies = {
    resolveShopId: async () => "shop1",
    recover: async () => {},
    claim: async () => ({ ...item }),
    beforeInvoke: async () =>
      revokeProviderLifecycleWithClient(h.client, domain),
    canInvoke: (shopId, expectedHost) =>
      isIndexNowLifecycleReadyWithClient(h.client, shopId, expectedHost),
    invoke: async () => {
      http++;
      throw new Error("must not invoke");
    },
    createAttempt: async () => {
      attempts++;
    },
    complete: async () => {
      throw new Error("must not complete");
    },
    fail: async (...args) => {
      failures.push(args);
      return { outcome: "ownership_lost" };
    },
    now: () => token,
  };
  const result = await executeOneIndexNowItem(
    {
      INDEXNOW_EXECUTION_ENABLED: "true",
      INDEXNOW_KEY: "synthetic-test-key",
      INDEXNOW_KEY_LOCATION: `https://${host}/synthetic-test-key.txt`,
      INDEXNOW_SHOP_DOMAIN: domain,
    },
    dependencies,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "PROVIDER_LIFECYCLE_NOT_READY");
  assert.equal(http, 0);
  assert.equal(attempts, 0);
  assert.equal(failures[0][4], true);
  assert.deepEqual(failures[0][1], token); // no retry loop or forged CAS
});
test("tenant/host/session isolation fails closed", async () => {
  const h = database();
  assert.equal(
    await isIndexNowLifecycleReadyWithClient(
      h.client,
      "shop1",
      "other.example",
    ),
    false,
  );
  h.sessions.delete(domain);
  assert.equal(
    await isIndexNowLifecycleReadyWithClient(h.client, "shop1", host),
    false,
  );
  assert.equal(
    await isIndexNowLifecycleReadyWithClient(h.client, "shop2", host),
    true,
  );
});
