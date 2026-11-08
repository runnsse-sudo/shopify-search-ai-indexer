import { createHash } from "node:crypto";
import type { AdminGraphqlClient } from "../shopify-product.server";
import { generatePublicLlmCatalog } from "./llm-catalog.server.ts";
import {
  validateCatalogTarget,
  type CatalogTarget,
} from "./multishop-catalog-targets.ts";
import type { CatalogStorage } from "./multishop-catalog-storage.server.ts";
import {
  stageCatalog,
  replaceCatalog,
  readCatalogFile,
} from "./robotto-catalog-publication.server.ts";
const limit = 8 * 1024 * 1024;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
type PublicationInput = {
  admin: AdminGraphqlClient;
  candidate: Uint8Array;
  backup: Uint8Array;
  expectedPreviousSha256: string;
  transport?: typeof fetch;
  wait?: () => Promise<void>;
};

// A factory binds every read, mutation and verification to one approved store/file.
export function catalogPublisher(inputTarget: CatalogTarget) {
  const target = validateCatalogTarget(inputTarget);
  const { shop, fileId, primaryDomain, cdnPath } = target;
  const publicUrl =
    "https://" + primaryDomain + "/cdn/shop/files/llms-full.txt";
  function productLinks(bytes: Uint8Array) {
    const lines = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .trimEnd()
      .split(/\r?\n/);
    const heading = lines.indexOf("## Products");
    if (
      lines[0] !== `# ${primaryDomain}` ||
      heading < 0 ||
      heading === lines.length - 1
    ) {
      throw new Error("INVALID_CATALOG_CATALOG");
    }
    const links = new Set<string>();
    for (const line of lines.slice(heading + 1)) {
      const match = /^- \[.+\]\((https:\/\/[^)]+)\)$/.exec(line);
      if (
        !match ||
        new URL(match[1]).origin !== `https://${primaryDomain}` ||
        !/^\/(?:[a-zA-Z-]+\/)?products\/[a-zA-Z0-9_%~-]+\/?$/.test(
          new URL(match[1]).pathname,
        ) ||
        new URL(match[1]).search ||
        new URL(match[1]).hash ||
        links.has(match[1])
      )
        throw new Error("INVALID_CATALOG_PRODUCT_LINK");
      links.add(match[1]);
    }
    return links;
  }

  async function readPublicCatalog(transport: typeof fetch, url: string) {
    const response = await transport(url, {
      cache: "no-store",
      redirect: "error",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) throw new Error("PUBLIC_READ_FAILED");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, size);
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw new Error("PUBLIC_FILE_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function inspectCatalog(admin: AdminGraphqlClient) {
    const response = await admin.graphql(readCatalogFile, {
      variables: { id: fileId },
    });
    if (!response.ok) throw new Error("SHOPIFY_HTTP_FAILED");
    const body = await response.json();
    if (!body.data || body.errors?.length)
      throw new Error("SHOPIFY_GRAPHQL_FAILED");
    const data = body.data;
    const file = data.node;
    if (data.shop?.myshopifyDomain !== shop || !file || file.id !== fileId)
      throw new Error("SHOP_OR_FILE_MISMATCH");
    if (
      !data.currentAppInstallation?.accessScopes.some(
        (scope: { handle: string }) => scope.handle === "write_files",
      )
    ) {
      throw new Error("WRITE_FILES_NOT_GRANTED");
    }
    if (file.fileStatus !== "READY") return null;
    const url = typeof file.url === "string" ? URL.parse(file.url) : null;
    if (
      !url ||
      url.protocol !== "https:" ||
      url.host !== "cdn.shopify.com" ||
      url.pathname !== cdnPath ||
      !/^\?v=[0-9]+$/.test(url.search) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("SHOPIFY_FILE_URL_MISMATCH");
    }
    return { canonical: url.href, download: publicUrl + url.search };
  }

  async function readVerifiedCatalog(
    admin: AdminGraphqlClient,
    transport: typeof fetch,
  ) {
    const file = await inspectCatalog(admin);
    if (!file) throw new Error("FILE_NOT_READY");
    const canonical = await readPublicCatalog(transport, file.canonical);
    const published = await readPublicCatalog(transport, file.download);
    const current = await inspectCatalog(admin);
    if (
      sha(canonical) !== sha(published) ||
      current?.canonical !== file.canonical
    ) {
      throw new Error("PUBLIC_HASH_NOT_VERIFIED");
    }
    return published;
  }

  async function refresh(
    storage: CatalogStorage,
    sessionShop: string,
    admin: AdminGraphqlClient | (() => Promise<AdminGraphqlClient>),
    transport: typeof fetch = fetch,
    now = () => Date.now(),
  ) {
    if (sessionShop !== shop || storage.shop !== shop)
      throw new Error("CATALOG_TENANT_MISMATCH");
    return storage.withLock(async () => {
      const started = now();
      const state = await storage.readDailyState();
      const targetSha256 = sha(Buffer.from(JSON.stringify(target)));
      if (state && state.targetSha256 !== targetSha256)
        throw new Error("CATALOG_STATE_TARGET_DRIFT");
      if (
        state &&
        (state.completedAt > started ||
          Math.floor(started / 86_400_000) ===
            Math.floor(state.completedAt / 86_400_000))
      ) {
        if (state.completedAt > started) throw new Error("CATALOG_CLOCK_DRIFT");
        return { status: "NOT_DUE", sha256: state.sha256 } as const;
      }
      const client = typeof admin === "function" ? await admin() : admin;
      const response = await client.graphql(`#graphql
      query DailyCatalogCount {
        shop { myshopifyDomain primaryDomain { host } }
        productsCount(limit: null, query: "status:active published_status:online_store_channel") { count precision }
      }`);
      const result = await response.json();
      const total = result.data?.productsCount;
      if (
        !response.ok ||
        result.errors?.length ||
        result.data?.shop?.myshopifyDomain !== shop ||
        result.data?.shop?.primaryDomain?.host !== primaryDomain ||
        total?.precision !== "EXACT" ||
        !Number.isSafeInteger(total.count) ||
        total.count <= 0
      )
        throw new Error("CATALOG_COUNT_UNVERIFIED");
      const catalog = await generatePublicLlmCatalog(
        client,
        primaryDomain,
        true,
      );
      const candidate = Buffer.from(catalog.text);
      if (catalog.count !== total.count || candidate.length > limit)
        throw new Error("CATALOG_INCOMPLETE");
      const backup = await readVerifiedCatalog(client, transport);
      const previous = productLinks(backup);
      const next = productLinks(candidate);
      let outcome;
      if (
        previous.size === next.size &&
        [...next].every((link) => previous.has(link))
      ) {
        outcome = { status: "UNCHANGED", sha256: sha(backup) } as const;
      } else {
        const stored = await storage.persistBackup(backup, sha(backup));
        outcome = await publish({
          admin: client,
          transport,
          candidate,
          backup: stored,
          expectedPreviousSha256: sha(backup),
        });
      }
      if (outcome.status !== "ROLLED_BACK")
        await storage.saveDailyState({
          completedAt: now(),
          sha256: outcome.sha256,
          targetSha256,
        });
      return outcome;
    });
  }
  async function publish(input: PublicationInput) {
    const { admin } = input;
    const candidate = Uint8Array.from(input.candidate);
    const backup = Uint8Array.from(input.backup);
    const transport = input.transport ?? fetch;
    const wait =
      input.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 3000)));
    const oldSha = sha(backup);
    const newSha = sha(candidate);
    const validCatalog = (bytes: Uint8Array) =>
      bytes.length <= limit &&
      new TextDecoder().decode(bytes).startsWith(`# ${primaryDomain}\n`);
    productLinks(candidate);
    productLinks(backup);
    if (
      !validCatalog(candidate) ||
      !validCatalog(backup) ||
      oldSha !== input.expectedPreviousSha256
    ) {
      throw new Error("INVALID_CATALOG_OR_BACKUP");
    }

    async function query<T>(
      operation: string,
      variables: Record<string, unknown>,
    ): Promise<T> {
      const response = await admin.graphql(operation, { variables });
      if (!response.ok) throw new Error("SHOPIFY_HTTP_FAILED");
      const body = (await response.json()) as { data?: T; errors?: unknown[] };
      if (!body.data || body.errors?.length)
        throw new Error("SHOPIFY_GRAPHQL_FAILED");
      return body.data;
    }

    async function inspect() {
      return inspectCatalog(admin);
    }

    async function readPublic() {
      return sha(await readVerifiedCatalog(admin, transport));
    }

    async function stage(bytes: Uint8Array) {
      const data = await query<{
        stagedUploadsCreate: {
          stagedTargets: {
            url: string;
            resourceUrl: string;
            parameters: { name: string; value: string }[];
          }[];
          userErrors: unknown[];
        };
      }>(stageCatalog, {
        input: [
          {
            filename: "llms-full.txt",
            mimeType: "text/plain",
            resource: "FILE",
            httpMethod: "POST",
            fileSize: String(bytes.length),
          },
        ],
      });
      const { stagedTargets, userErrors } = data.stagedUploadsCreate;
      if (userErrors.length || stagedTargets.length !== 1)
        throw new Error("STAGING_REJECTED");
      const target = stagedTargets[0];
      const upload = URL.parse(target.url);
      const resource = URL.parse(target.resourceUrl);
      if (
        !upload ||
        !resource ||
        [upload, resource].some(
          (url) =>
            url.protocol !== "https:" ||
            url.host !== "shopify-staged-uploads.storage.googleapis.com" ||
            url.username ||
            url.password ||
            url.hash,
        )
      )
        throw new Error("STAGING_TARGET_MISMATCH");

      const form = new FormData();
      for (const { name, value } of target.parameters) form.append(name, value);
      form.append(
        "file",
        new Blob([Uint8Array.from(bytes)], { type: "text/plain" }),
        "llms-full.txt",
      );
      const response = await transport(upload.href, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("STAGING_UPLOAD_FAILED");
      return resource.href;
    }

    async function replace(originalSource: string) {
      const result = await query<{
        fileUpdate: { files: { id: string }[]; userErrors: unknown[] };
      }>(replaceCatalog, { files: [{ id: fileId, originalSource }] });
      if (
        result.fileUpdate.userErrors.length ||
        result.fileUpdate.files.length !== 1 ||
        result.fileUpdate.files[0].id !== fileId
      )
        throw new Error("FILE_UPDATE_REJECTED");
    }

    async function verify(expected: string) {
      for (let attempt = 0; attempt < 6; attempt++) {
        if ((await inspect()) && (await readPublic()) === expected) return;
        if (attempt < 5) await wait();
      }
      throw new Error("PUBLIC_HASH_NOT_VERIFIED");
    }

    if (!(await inspect())) throw new Error("FILE_NOT_READY");
    if ((await readPublic()) !== oldSha)
      throw new Error("PUBLIC_BASELINE_DRIFT");
    if (oldSha === newSha)
      return { status: "UNCHANGED", sha256: oldSha } as const;

    const next = await stage(candidate);
    const restore = await stage(backup);
    if (next === restore) throw new Error("STAGING_SOURCE_COLLISION");
    if (!(await inspect()) || (await readPublic()) !== oldSha)
      throw new Error("PUBLIC_BASELINE_DRIFT");
    try {
      await replace(next);
      await verify(newSha);
      return { status: "PUBLISHED", sha256: newSha } as const;
    } catch {
      // A timeout may hide a successful write. Only roll back a confirmed candidate.
      if (!(await inspect()) || (await readPublic()) !== newSha) {
        throw new Error("PUBLICATION_UNCONFIRMED");
      }
      await replace(restore);
      await verify(oldSha);
      return { status: "ROLLED_BACK", sha256: oldSha } as const;
    }
  }

  return { refresh };
}
