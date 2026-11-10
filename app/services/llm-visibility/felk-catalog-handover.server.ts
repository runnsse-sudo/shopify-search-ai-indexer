import { createHash } from "node:crypto";
import type { AdminGraphqlClient } from "../shopify-product.server";
import { catalogPublisher } from "./multishop-catalog-publication.server.ts";
import {
  parseFelkHandoverConfig,
  type FelkHandoverConfig,
  validateCatalogTarget,
  type CatalogTarget,
} from "./multishop-catalog-targets.ts";
import type { CatalogStorage } from "./multishop-catalog-storage.server.ts";
import type { CatalogPhase } from "./robotto-catalog-diagnostics.ts";
import { createFelkCatalogCandidate } from "./felk-catalog-candidate.server.ts";
import {
  felkCatalogAddress,
  felkCatalogUrls,
  verifyFelkCatalogAddress,
} from "./felk-catalog-address.ts";
import { readCatalogFile } from "./robotto-catalog-publication.server.ts";

const shop = "94d715-94.myshopify.com";
const key = "felk_catalog_pointer";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => {
  throw new Error(code);
};
export { parseFelkHandoverConfig };

type Pointer = {
  schema: "FELK_CATALOG_POINTER_V1";
  shop: string;
  fileId: string;
  sha256: string;
  canonical: string;
  download: string;
};
type Snapshot = {
  value: string;
  compareDigest: string;
  pointer: Pointer;
  target: CatalogTarget;
};
export const readFelkPointer = `query ReadFelkPointer($namespace: String!, $key: String!) {
  shop { id myshopifyDomain primaryDomain { host }
    metafield(namespace: $namespace, key: $key) {
      namespace key type value compareDigest
      definition { ownerType namespace key type { name } access { admin storefront } }
    }
  }
  currentAppInstallation { app { id } }
}`;
export const setFelkPointer = `mutation SetFelkPointer($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { namespace key type value compareDigest }
    userErrors { code }
  }
}`;

function decodePointer(value: string): {
  pointer: Pointer;
  target: CatalogTarget;
} {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096)
    return fail("CATALOG_POINTER_DRIFT");
  let pointer;
  try {
    pointer = JSON.parse(value);
  } catch {
    return fail("CATALOG_POINTER_DRIFT");
  }
  if (
    !pointer ||
    Object.keys(pointer).sort().join() !==
      "canonical,download,fileId,schema,sha256,shop" ||
    pointer.schema !== "FELK_CATALOG_POINTER_V1" ||
    pointer.shop !== shop ||
    !/^[a-f0-9]{64}$/.test(pointer.sha256)
  )
    return fail("CATALOG_POINTER_DRIFT");
  const target = validateCatalogTarget({
    shop,
    primaryDomain: "www.felkodslasare.se",
    fileId: pointer.fileId,
    cdnPath: `/s/files/1/0746/4979/6876/files/llms-full-${pointer.sha256}.txt`,
    contentSha256: pointer.sha256,
  });
  const canonical = new URL(pointer.canonical);
  if (
    canonical.href !== pointer.canonical ||
    canonical.origin !== "https://cdn.shopify.com" ||
    canonical.pathname !== target.cdnPath ||
    !/^\?v=[0-9]+$/.test(canonical.search) ||
    canonical.hash ||
    canonical.username ||
    canonical.password ||
    pointer.download !==
      `https://${target.primaryDomain}/cdn/shop/files/${canonical.pathname.split("/").at(-1)}${canonical.search}`
  )
    return fail("CATALOG_POINTER_DRIFT");
  return { pointer, target };
}

/** No theme writer or activation. Called only by an explicitly configured worker. */
export async function refreshFelkAutomaticCatalog(input: {
  target: CatalogTarget;
  config: FelkHandoverConfig;
  storage: CatalogStorage;
  admin: () => Promise<AdminGraphqlClient>;
  transport?: typeof fetch;
  wait?: () => Promise<void>;
  now?: () => number;
  onPhase?: (phase: CatalogPhase) => void;
}) {
  const config = parseFelkHandoverConfig(JSON.stringify(input.config))!;
  const bootstrap = validateCatalogTarget(input.target);
  if (
    bootstrap.shop !== shop ||
    !bootstrap.contentSha256 ||
    input.storage.shop !== shop
  )
    return fail("CATALOG_TENANT_MISMATCH");
  const transport = input.transport ?? fetch;
  const wait =
    input.wait ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 3000)));
  const onPhase = input.onPhase ?? (() => {});
  return input.storage.withLock(async () => {
    onPhase("session");
    const admin = await input.admin();
    async function query(
      operation: string,
      variables: Record<string, unknown>,
    ) {
      const response = await admin.graphql(operation, { variables });
      if (!response.ok) return fail("SHOPIFY_HTTP_FAILED");
      const body = await response.json();
      if (body.errors?.length || !body.data)
        return fail("SHOPIFY_GRAPHQL_FAILED");
      return body.data;
    }
    async function readPointer(): Promise<Snapshot> {
      const data = await query(readFelkPointer, {
        namespace: config.namespace,
        key,
      });
      const owner = data.shop;
      const meta = owner?.metafield;
      const definition = meta?.definition;
      if (
        owner?.id !== config.ownerId ||
        owner.myshopifyDomain !== shop ||
        owner.primaryDomain?.host !== bootstrap.primaryDomain ||
        data.currentAppInstallation?.app?.id !==
          `gid://shopify/App/${config.namespace.slice(5)}`
      )
        return fail("CATALOG_TENANT_MISMATCH");
      if (
        !meta ||
        meta.namespace !== config.namespace ||
        meta.key !== key ||
        meta.type !== "json" ||
        typeof meta.compareDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(meta.compareDigest) ||
        definition?.namespace !== config.namespace ||
        definition.key !== key ||
        definition.ownerType !== "SHOP" ||
        definition.type?.name !== "json" ||
        definition.access?.admin !== "MERCHANT_READ" ||
        definition.access?.storefront !== "PUBLIC_READ"
      )
        return fail("CATALOG_POINTER_NOT_QUALIFIED");
      return {
        value: meta.value,
        compareDigest: meta.compareDigest,
        ...decodePointer(meta.value),
      };
    }
    async function readPublic(url: string, limit: number) {
      const response = await transport(url, {
        redirect: "error",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !response.body) return fail("PUBLIC_READ_FAILED");
      const parts: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return Buffer.concat(parts, size);
          size += value.length;
          if (size > limit) {
            await reader.cancel();
            return fail("PUBLIC_FILE_TOO_LARGE");
          }
          parts.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    async function verifyFile(pointer: Pointer) {
      async function metadata() {
        const data = await query(readCatalogFile, { id: pointer.fileId });
        if (
          data.shop?.myshopifyDomain !== shop ||
          data.node?.id !== pointer.fileId ||
          data.node.fileStatus !== "READY" ||
          data.node.url !== pointer.canonical
        )
          return fail("PUBLIC_FILE_VERSION_DRIFT");
        if (
          !data.currentAppInstallation?.accessScopes?.some(
            (s: { handle: string }) => s.handle === "write_files",
          )
        )
          return fail("WRITE_FILES_NOT_GRANTED");
      }
      await metadata();
      const canonical = await readPublic(pointer.canonical, 8 * 1024 * 1024);
      const download = await readPublic(pointer.download, 8 * 1024 * 1024);
      await metadata();
      if (
        digest(canonical) !== pointer.sha256 ||
        digest(download) !== pointer.sha256 ||
        canonical.length !== download.length
      )
        return fail("PUBLIC_HASH_NOT_VERIFIED");
      return download;
    }
    async function discovery(pointer: Pointer, retries: boolean) {
      for (let i = 0; i < (retries ? 6 : 1); i++) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          await readPublic(
            `https://${bootstrap.primaryDomain}/llms-full.txt`,
            128 * 1024,
          ),
        );
        const urls = [...text.matchAll(/\]\((https:\/\/[^\s)]+)\)/g)]
          .map((m) => m[1])
          .filter((u) => /llms-full/.test(new URL(u).pathname));
        if (urls.length === 1 && urls[0] === pointer.download) return;
        if (i < (retries ? 5 : 0)) await wait();
      }
      return fail("CATALOG_DISCOVERY_DRIFT");
    }
    function same(a: Snapshot, b: Snapshot) {
      return a.value === b.value && a.compareDigest === b.compareDigest;
    }
    async function cas(expected: Snapshot, value: string): Promise<Snapshot> {
      const fresh = await readPointer();
      if (!same(fresh, expected)) return fail("CATALOG_POINTER_DRIFT");
      const data = await query(setFelkPointer, {
        metafields: [
          {
            ownerId: config.ownerId,
            namespace: config.namespace,
            key,
            type: "json",
            value,
            compareDigest: expected.compareDigest,
          },
        ],
      });
      const result = data.metafieldsSet;
      if (
        !result ||
        result.userErrors?.length ||
        result.metafields?.length !== 1
      )
        return fail("CATALOG_POINTER_WRITE_UNCONFIRMED");
      const written = result.metafields[0];
      if (
        written.value !== value ||
        written.namespace !== config.namespace ||
        written.key !== key ||
        written.type !== "json" ||
        !/^[a-f0-9]{64}$/.test(written.compareDigest)
      )
        return fail("CATALOG_POINTER_WRITE_UNCONFIRMED");
      const after = await readPointer();
      if (
        after.value !== value ||
        after.compareDigest !== written.compareDigest
      )
        return fail("CATALOG_POINTER_WRITE_UNCONFIRMED");
      return after;
    }
    const before = await readPointer();
    await verifyFile(before.pointer);
    await discovery(before.pointer, false);
    let borrowed = false;
    const storage: CatalogStorage = {
      ...input.storage,
      async withLock<T>(run: () => Promise<T>) {
        if (borrowed) return fail("CATALOG_LOCK_REQUIRED");
        borrowed = true;
        return run();
      },
    };
    return catalogPublisher(
      before.target,
      onPhase,
      "existing-file",
      async ({ candidate, previous, previousUrl, storage }) => {
        if (
          JSON.stringify(previous) !== JSON.stringify(before.target) ||
          previousUrl !== before.pointer.canonical
        )
          return fail("CATALOG_POINTER_DRIFT");
        const backup = Buffer.from(
          JSON.stringify({
            schema: "FELK_POINTER_ROLLBACK_V1",
            ownerId: config.ownerId,
            namespace: config.namespace,
            key,
            value: before.value,
            compareDigest: before.compareDigest,
            target: before.target,
          }),
        );
        const restored = await storage.persistBackup(backup, digest(backup));
        if (!Buffer.from(restored).equals(backup))
          return fail("PERSISTED_BACKUP_MISMATCH");
        if (!same(await readPointer(), before))
          return fail("CATALOG_POINTER_DRIFT");
        const created = await createFelkCatalogCandidate({
          admin,
          candidate,
          transport,
          wait,
          onPhase,
          expectedLegacyUrl: before.pointer.canonical,
          expectedPreviousFileId: before.pointer.fileId,
        });
        const planned = felkCatalogAddress(shop, candidate);
        const urls = felkCatalogUrls(planned, {
          shop,
          id: created.fileId,
          status: "READY",
          url: created.canonical,
        });
        const next: Pointer = {
          schema: "FELK_CATALOG_POINTER_V1",
          shop,
          fileId: created.fileId,
          sha256: created.sha256,
          canonical: urls.canonical,
          download: urls.download,
        };
        decodePointer(JSON.stringify(next));
        await verifyFile(before.pointer);
        await discovery(before.pointer, false);
        await verifyFile(next);
        const committed = await cas(before, JSON.stringify(next));
        try {
          await discovery(next, true);
          await verifyFile(next);
          if (!same(await readPointer(), committed))
            return fail("CATALOG_POINTER_DRIFT");
        } catch {
          // A confirmed pointer write may be rolled back only with its current CAS digest.
          // Unknown mutation outcomes never enter this block and never trigger a blind write.
          await verifyFile(before.pointer);
          await cas(committed, before.value);
          await discovery(before.pointer, true);
          return fail("CATALOG_LINK_ROLLED_BACK");
        }
        return committed.target;
      },
    ).refresh(storage, shop, admin, transport, input.now, wait);
  });
}

/** Preparation only. A separately approved one-time template installation is required. */
export function felkCatalogDiscoveryTemplate(
  config: FelkHandoverConfig,
  verifiedValue: string,
) {
  parseFelkHandoverConfig(JSON.stringify(config));
  const { pointer } = decodePointer(verifiedValue);
  return `{% assign catalog_pointer = shop.metafields['${config.namespace}'].felk_catalog_pointer.value %}
# www.felkodslasare.se - public product catalog

> Public Online Store product links. Check product pages for current prices and stock.

## Catalog

{% if catalog_pointer.schema == 'FELK_CATALOG_POINTER_V1' and catalog_pointer.shop == '94d715-94.myshopify.com' %}
- [Download the complete public product catalog]({{ catalog_pointer.download }})
{% else %}
- [Download the complete public product catalog](${pointer.download})
{% endif %}
- [Store discovery information](https://www.felkodslasare.se/agents.md)
`;
}

/** Local proposal only; never creates a definition, value or runtime permission. */
export function prepareFelkPointerBootstrap(
  config: FelkHandoverConfig,
  proof: Parameters<typeof verifyFelkCatalogAddress>[0],
) {
  parseFelkHandoverConfig(JSON.stringify(config));
  const verified = verifyFelkCatalogAddress(proof);
  const value = JSON.stringify({
    schema: "FELK_CATALOG_POINTER_V1",
    shop,
    fileId: proof.before.id,
    sha256: verified.sha256,
    canonical: verified.canonical,
    download: verified.download,
  });
  decodePointer(value);
  return Object.freeze({
    requiresSeparateSetupApproval: true,
    variables: {
      metafields: [
        {
          ownerId: config.ownerId,
          namespace: config.namespace,
          key,
          type: "json",
          value,
          compareDigest: null,
        },
      ],
    },
    template: felkCatalogDiscoveryTemplate(config, value),
  });
}
