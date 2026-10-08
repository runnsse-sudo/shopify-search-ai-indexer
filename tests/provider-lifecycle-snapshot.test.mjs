import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { build, stop } from "esbuild";
import { Prisma } from "@prisma/client";
import {
  isIndexNowLifecycleReady,
  isIndexNowLifecycleReadyWithClient,
  revokeProviderLifecycleWithClient,
} from "../app/services/provider-lifecycle.ts";
import { encryptProviderCredential } from "../app/services/provider-config-crypto.ts";

const domain = "snapshot.myshopify.com";
const host = "store.example";
const master = Buffer.alloc(32, 2).toString("base64");
const key = "snapshot-fixture-key";
const encrypted = encryptProviderCredential(
  JSON.stringify({
    version: 1,
    key,
    keyLocation: `https://${host}/${key}.txt`,
  }),
  master,
);
const item = {
  id: "queue1",
  shopId: "shop1",
  provider: "INDEXNOW",
  action: "INDEX",
  status: "PROCESSING",
  claimedAt: new Date(1000),
  retryCount: 0,
  url: `https://${host}/products/one`,
};

function fixture(installed = true) {
  const state = {
    config: {
      shopId: "shop1",
      indexNowEnabled: true,
      indexNowAllowedHost: host,
      indexNowOwnershipVerifiedAt: new Date(1000),
      indexNowCredentialCiphertext: encrypted.ciphertext,
      indexNowCredentialIv: encrypted.iv,
      indexNowCredentialTag: encrypted.tag,
      shop: { id: "shop1", domain, primaryDomain: host },
    },
    sessions: new Set(installed ? [domain] : []),
    queue: { ...item },
  };
  const h = {
    state,
    transactions: 0,
    active: 0,
    rootReads: 0,
    posts: 0,
    attempts: 0,
    conflicts: 0,
    afterConfig: null,
    failError: null,
  };
  function reader(snapshot, isRoot) {
    return {
      shopProviderConfig: {
        findUnique: async ({ where }) => {
          if (isRoot) h.rootReads++;
          assert.equal(where.shopId, "shop1");
          const config = structuredClone(snapshot.config);
          await h.afterConfig?.();
          return config;
        },
        findMany: async ({ take, orderBy }) => {
          if (isRoot) h.rootReads++;
          assert.equal(take, 10);
          assert.equal(orderBy[1].shopId, "asc");
          const rows =
            snapshot.config?.indexNowEnabled &&
            snapshot.config.indexNowOwnershipVerifiedAt
              ? [structuredClone(snapshot.config)]
              : [];
          await h.afterConfig?.();
          return rows;
        },
      },
      session: {
        findFirst: async ({ where, select }) => {
          if (isRoot) h.rootReads++;
          assert.deepEqual(select, { id: true });
          assert.equal(where.shop, domain);
          assert.equal(where.isOnline, false);
          return snapshot.sessions.has(where.shop)
            ? { id: "offline-fixture" }
            : null;
        },
      },
    };
  }
  h.root = {
    ...reader(state, true),
    shop: {
      findUnique: async () => ({ id: "shop1", domain, primaryDomain: host }),
    },
    indexQueueItem: {
      updateMany: async ({ where, data }) => {
        assert.equal(where.shopId, "shop1");
        assert.equal(where.provider, "INDEXNOW");
        if (where.status.in.includes(state.queue.status))
          Object.assign(state.queue, data);
      },
    },
    $transaction: async (callback, options) => {
      assert.equal(options.isolationLevel, "Serializable");
      h.transactions++;
      h.active++;
      // Model one database snapshot, with detached results and no nested transaction API.
      const snapshot = structuredClone(state);
      try {
        const result = await callback(reader(snapshot, false));
        if (h.conflicts-- > 0)
          throw new Prisma.PrismaClientKnownRequestError("fixture conflict", {
            code: "P2034",
            clientVersion: Prisma.prismaVersion.client,
          });
        if (h.failError) throw h.failError;
        return result;
      } finally {
        h.active--;
      }
    },
  };
  h.root.shopProviderConfig.updateMany = async ({ where, data }) => {
    assert.equal(where.shopId, "shop1");
    Object.assign(state.config, data);
  };
  h.root.session.deleteMany = async ({ where }) =>
    state.sessions.delete(where.shop);
  return h;
}

function interleaveRevocation(h) {
  h.afterConfig = async () => {
    h.afterConfig = null;
    await revokeProviderLifecycleWithClient(h.root, domain);
    h.state.sessions.add(domain);
  };
}

// Compile actual worker wiring and config retrieval. Only persistence is substituted.
mkdirSync(new URL("../build-tests/", import.meta.url), { recursive: true });
const fixturePlugin = {
  name: "snapshot-persistence-fixture",
  setup(builder) {
    builder.onResolve(
      { filter: /(?:db|index-queue|index-attempt)\.server$/ },
      ({ path }) => ({
        path,
        namespace: "snapshot-fixture",
      }),
    );
    builder.onLoad(
      { filter: /.*/, namespace: "snapshot-fixture" },
      ({ path }) => ({
        loader: "js",
        contents: path.endsWith("db.server")
          ? "export default new Proxy({}, { get: (_, name) => globalThis.snapshotFixture.root[name] });"
          : path.endsWith("index-attempt.server")
            ? "export const createIndexAttempt = async () => { globalThis.snapshotFixture.attempts++; return { attemptNumber: 1 }; };"
            : "export const recoverExpiredProcessing = async () => {}; export const claimNext = async () => ({ ...globalThis.snapshotFixture.state.queue }); export const markCompleted = async () => ({ outcome: 'ownership_lost' }); export const markFailed = async () => ({ outcome: 'ownership_lost' });",
      }),
    );
  },
};
for (const [entry, outfile] of [
  ["workers/indexnow-worker.ts", "build-tests/snapshot-indexnow-worker.mjs"],
  [
    "app/services/indexnow-shop-config.server.ts",
    "build-tests/snapshot-runtime-config.mjs",
  ],
])
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [fixturePlugin],
  });
stop();
const server = await import("../build-tests/snapshot-runtime-config.mjs");
let workerRun = 0;
async function runWorker(h) {
  globalThis.snapshotFixture = h;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  h.root.$disconnect = async () => finish();
  const env = {
    INDEXNOW_EXECUTION_ENABLED: "true",
    INDEXNOW_SHOP_DOMAIN: domain,
    INDEXNOW_KEY: key,
    INDEXNOW_KEY_LOCATION: `https://${host}/${key}.txt`,
    INDEXNOW_MAX_ITEMS: "1",
    INDEXNOW_INTER_ITEM_DELAY_MS: "0",
    INDEXNOW_ALLOWED_HOST: host,
  };
  const oldEnv = Object.fromEntries(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  const oldFetch = globalThis.fetch;
  const oldExit = process.exitCode;
  const handlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [signal, process.listeners(signal)]),
  );
  Object.assign(process.env, env);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(h.active, 0); // Provider HTTP begins only after snapshot transaction commits.
    h.posts++;
    return new Response(null, { status: 202 });
  };
  try {
    await import(
      `../build-tests/snapshot-indexnow-worker.mjs?run=${++workerRun}`
    );
    await finished;
    return process.exitCode;
  } finally {
    globalThis.fetch = oldFetch;
    process.exitCode = oldExit;
    for (const [name, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [signal, previous] of handlers)
      for (const handler of process.listeners(signal)) {
        if (!previous.includes(handler))
          process.removeListener(signal, handler);
      }
  }
}

test("actual worker rejects old config plus recreated Session: zero POST and attempt", async () => {
  const h = fixture(false);
  interleaveRevocation(h);
  await runWorker(h);
  assert.equal(h.posts, 0);
  assert.equal(h.attempts, 0);
  assert.equal(h.transactions, 1);
  assert.equal(h.rootReads, 0);
  assert.equal(h.state.config.indexNowOwnershipError, "APP_UNINSTALLED");
  assert.equal(h.state.queue.status, "CANCELLED");
});

test("coherent pre-revocation snapshot without Session is false", async () => {
  const h = fixture(false);
  interleaveRevocation(h);
  assert.equal(await isIndexNowLifecycleReady(h.root, "shop1", host), false);
  assert.equal(h.rootReads, 0);
});
test("post-revocation snapshot and Session-only reinstall are false", async () => {
  const h = fixture();
  await revokeProviderLifecycleWithClient(h.root, domain);
  h.state.sessions.add(domain);
  assert.equal(await isIndexNowLifecycleReady(h.root, "shop1", host), false);
});
test("fully coherent ready provider and matching host still authorize actual worker", async () => {
  const h = fixture();
  await runWorker(h);
  assert.equal(h.posts, 1);
  assert.equal(h.attempts, 1);
  assert.equal(h.transactions, 1);
  assert.equal(h.rootReads, 0);
});
test("different host or another tenant Session cannot authorize", async () => {
  const h = fixture();
  assert.equal(
    await isIndexNowLifecycleReady(h.root, "shop1", "other.example"),
    false,
  );
  h.state.sessions = new Set(["other.myshopify.com"]);
  assert.equal(await isIndexNowLifecycleReady(h.root, "shop1", host), false);
});
test("new config cannot combine with old Session; explicit full reactivation succeeds", async () => {
  const h = fixture();
  await revokeProviderLifecycleWithClient(h.root, domain);
  const revoked = structuredClone(h.state.config);
  Object.assign(h.state.config, {
    indexNowEnabled: true,
    indexNowOwnershipVerifiedAt: new Date(2000),
  });
  h.afterConfig = async () => {
    h.afterConfig = null;
    h.state.config = revoked;
    h.state.sessions.add(domain);
  };
  assert.equal(await isIndexNowLifecycleReady(h.root, "shop1", host), false);
  Object.assign(h.state.config, {
    indexNowEnabled: true,
    indexNowOwnershipVerifiedAt: new Date(3000),
  });
  assert.equal(await isIndexNowLifecycleReady(h.root, "shop1", host), true);
});
test("existing transaction helper has no nested transaction", async () => {
  const h = fixture();
  assert.equal(
    await h.root.$transaction(
      (tx) => isIndexNowLifecycleReadyWithClient(tx, "shop1", host),
      { isolationLevel: "Serializable" },
    ),
    true,
  );
  assert.equal(h.transactions, 1);
});
test("commit conflicts retry before POST; exhausted conflicts fail closed", async () => {
  const recovered = fixture();
  recovered.conflicts = 2;
  await runWorker(recovered);
  assert.equal(recovered.transactions, 3);
  assert.equal(recovered.posts, 1);
  const exhausted = fixture();
  exhausted.conflicts = 3;
  assert.equal(await runWorker(exhausted), 1);
  assert.equal(exhausted.transactions, 3);
  assert.equal(exhausted.posts, 0);
  assert.equal(exhausted.attempts, 0);
});
test("nonserialization transaction failure prevents provider invocation", async () => {
  const h = fixture();
  h.failError = new Error("fixture database unavailable");
  assert.equal(await runWorker(h), 1);
  assert.equal(h.transactions, 1);
  assert.equal(h.posts, 0);
  assert.equal(h.attempts, 0);
});
test("actual runtime config cannot decrypt old config using a new Session", async () => {
  const h = fixture(false);
  globalThis.snapshotFixture = h;
  interleaveRevocation(h);
  assert.equal(
    await server.getReadyIndexNowRuntimeConfig("shop1", {
      PROVIDER_CONFIG_MASTER_KEY: master,
    }),
    null,
  );
  assert.equal(h.transactions, 1);
  assert.equal(h.rootReads, 0);
});
test("actual runtime config returns credentials from its eligible snapshot", async () => {
  const h = fixture();
  globalThis.snapshotFixture = h;
  const result = await server.getReadyIndexNowRuntimeConfig("shop1", {
    PROVIDER_CONFIG_MASTER_KEY: master,
  });
  assert.equal(result.key, key);
  assert.equal(result.allowedHost, host);
  assert.equal(h.transactions, 1);
  assert.equal(h.rootReads, 0);
});
for (const name of [
  "listReadyIndexNowShopsForExecution",
  "listReadyIndexNowShopsForMaterialization",
]) {
  test(`${name} uses one snapshot and preserves existing take/order`, async () => {
    const h = fixture(false);
    globalThis.snapshotFixture = h;
    interleaveRevocation(h);
    assert.deepEqual(await server[name](10), []);
    assert.equal(h.transactions, 1);
    assert.equal(h.rootReads, 0);
  });
}
