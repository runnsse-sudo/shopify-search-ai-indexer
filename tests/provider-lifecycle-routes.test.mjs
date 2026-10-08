import assert from "node:assert/strict";
import test from "node:test";
import { build, stop } from "esbuild";
import { mkdirSync } from "node:fs";
import { encryptProviderCredential } from "../app/services/provider-config-crypto.ts";
import { revokeProviderLifecycleWithClient } from "../app/services/provider-lifecycle.ts";

mkdirSync(new URL("../build-tests/", import.meta.url), { recursive: true });
const master = Buffer.alloc(32, 1).toString("base64");
const key = "synthetic-test-key";
const domain = "test.myshopify.com";
const host = "store.example";
const encrypted = encryptProviderCredential(
  JSON.stringify({
    version: 1,
    key,
    keyLocation: `https://${host}/${key}.txt`,
  }),
  master,
);
let state;
function reset() {
  state = {
    session: true,
    queryCount: 0,
    cancellations: 0,
    config: {
      shopId: "shop1",
      indexNowEnabled: true,
      indexNowAllowedHost: host,
      indexNowCredentialCiphertext: encrypted.ciphertext,
      indexNowCredentialIv: encrypted.iv,
      indexNowCredentialTag: encrypted.tag,
      indexNowOwnershipVerifiedAt: new Date(1000),
      updatedAt: new Date(1000),
      shop: { id: "shop1", domain, primaryDomain: host },
    },
  };
}
const client = {
  $transaction: async (callback) => callback(client),
  shop: {
    findUnique: async () => ({
      id: "shop1",
      domain,
      primaryDomain: host,
      providerConfig: { ...state.config },
    }),
  },
  session: {
    findFirst: async ({ select }) => {
      assert.deepEqual(select, { id: true });
      return state.session ? { id: "offline" } : null;
    },
    deleteMany: async () => {
      state.session = false;
    },
  },
  shopProviderConfig: {
    findUnique: async () => ({ ...state.config }),
    findMany: async () => {
      state.queryCount++;
      return state.config.indexNowEnabled &&
        state.config.indexNowOwnershipVerifiedAt
        ? [{ ...state.config }]
        : [];
    },
    updateMany: async ({ where, data }) => {
      if (
        where.updatedAt &&
        where.updatedAt.getTime() !== state.config.updatedAt.getTime()
      )
        return { count: 0 };
      Object.assign(state.config, data, {
        updatedAt: new Date(state.config.updatedAt.getTime() + 1),
      });
      return { count: 1 };
    },
    update: async ({ data }) => {
      Object.assign(state.config, data);
      return { ...state.config };
    },
  },
  indexQueueItem: {
    updateMany: async () => {
      state.cancellations++;
    },
  },
};
globalThis.prismaGlobal = client;
await build({
  entryPoints: ["app/services/indexnow-shop-config.server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "build-tests/provider-lifecycle-config-test.mjs",
});
await build({
  entryPoints: ["app/routes/webhooks.app.uninstalled.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "build-tests/provider-lifecycle-route-test.mjs",
  plugins: [
    {
      name: "authenticated-fixture",
      setup(builder) {
        builder.onResolve({ filter: /shopify\.server$/ }, () => ({
          path: "authenticated-fixture",
          namespace: "test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents:
            "export const authenticate = { webhook: async () => globalThis.uninstallAuth };",
          loader: "js",
        }));
      },
    },
  ],
});
stop();
const server =
  await import("../build-tests/provider-lifecycle-config-test.mjs");
const route = await import("../build-tests/provider-lifecycle-route-test.mjs");
const resolve = async () => [{ address: "93.184.216.34" }];
const env = { PROVIDER_CONFIG_MASTER_KEY: master };

for (const session of [{ id: "offline" }, undefined]) {
  test(`actual authenticated uninstall route revokes state, session ${session ? "present" : "absent"}`, async () => {
    reset();
    globalThis.uninstallAuth = {
      shop: domain,
      topic: "APP_UNINSTALLED",
      session,
    };
    assert.equal(
      (
        await route.action({
          request: new Request("https://app.example/webhooks/app/uninstalled"),
        })
      ).status,
      200,
    );
    assert.equal(state.config.indexNowEnabled, false);
    assert.equal(state.config.indexNowOwnershipVerifiedAt, null);
    assert.equal(state.session, false);
    assert.equal(state.cancellations, 1);
    await route.action({
      request: new Request("https://app.example/webhooks/app/uninstalled"),
    });
    assert.equal(state.config.indexNowEnabled, false);
    assert.equal(state.session, false);
  });
}
test("actual materialization and execution selectors reject installed-state leftovers", async () => {
  reset();
  state.session = false;
  assert.deepEqual(
    await server.listReadyIndexNowShopsForMaterialization(10),
    [],
  );
  assert.deepEqual(await server.listReadyIndexNowShopsForExecution(10), []);
  assert.equal(await server.getReadyIndexNowRuntimeConfig("shop1", env), null);
});
test("actual verification success requires offline installation and a current config version", async () => {
  reset();
  const result = await server.verifyIndexNowShopOwnership(domain, {
    env,
    resolve,
    fetchImpl: async () => new Response(key),
  });
  assert.equal(result.verified, true);
  assert.ok(state.config.indexNowOwnershipVerifiedAt);
});
test("uninstall during ownership fetch cannot restore verification even if Session is recreated", async () => {
  reset();
  await assert.rejects(
    server.verifyIndexNowShopOwnership(domain, {
      env,
      resolve,
      fetchImpl: async () => {
        await revokeProviderLifecycleWithClient(client, domain);
        state.session = true;
        return new Response(key);
      },
    }),
    /PROVIDER_LIFECYCLE_NOT_READY/,
  );
  assert.equal(state.config.indexNowEnabled, false);
  assert.equal(state.config.indexNowOwnershipVerifiedAt, null);
});
test("actual enable rejects absent installation and cannot reactivate revoked config after reinstall", async () => {
  reset();
  state.session = false;
  await assert.rejects(
    server.setIndexNowShopEnabled(domain, true, env),
    /APP_NOT_INSTALLED/,
  );
  assert.equal(state.config.indexNowEnabled, true); // no mutation on rejection; worker readiness still false
  await revokeProviderLifecycleWithClient(client, domain);
  state.session = true;
  await assert.rejects(
    server.setIndexNowShopEnabled(domain, true, env),
    /ownership must be verified/,
  );
  assert.equal(state.config.indexNowEnabled, false);
});
test("actual persisted ownership error never stores arbitrary key URL/response", async () => {
  reset();
  await assert.rejects(
    server.verifyIndexNowShopOwnership(domain, {
      env,
      resolve,
      fetchImpl: async () => {
        throw new Error(`https://${host}/${key}.txt internal/private details`);
      },
    }),
    /FETCH_FAILED/,
  );
  assert.equal(state.config.indexNowOwnershipError, "FETCH_FAILED");
  assert.equal(state.config.indexNowEnabled, false);
  assert.equal(state.config.indexNowOwnershipVerifiedAt, null);
});
