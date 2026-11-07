import { createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AdminGraphqlClient } from "../shopify-product.server";
import { generatePublicLlmCatalog } from "./llm-catalog.server.ts";
import type { RobottoCatalogStorage } from "./robotto-catalog-storage.server";

const shop = "robotto-7143.myshopify.com";
const fileId = "gid://shopify/GenericFile/62861370655066";
const publicUrl = "https://www.robotto.se/cdn/shop/files/llms-full.txt";
const limit = 8 * 1024 * 1024;

export const stageCatalog = `mutation StageRobottoCatalog($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field }
  }
}`;

export const replaceCatalog = `mutation ReplaceRobottoCatalog($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) {
    files { id fileStatus }
    userErrors { field }
  }
}`;

export const readCatalogFile = `query ReadRobottoCatalog($id: ID!) {
  shop { myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
  node(id: $id) { ... on GenericFile { id fileStatus url } }
}`;

type PublicationInput = {
  admin: AdminGraphqlClient;
  candidate: Uint8Array;
  backup: Uint8Array;
  expectedPreviousSha256: string;
  transport?: typeof fetch;
  wait?: () => Promise<void>;
};

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function productLinks(bytes: Uint8Array) {
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd().split(/\r?\n/);
  const heading = lines.indexOf("## Products");
  if (lines[0] !== "# www.robotto.se" || heading < 0 || heading === lines.length - 1) {
    throw new Error("INVALID_ROBOTTO_CATALOG");
  }
  const links = new Set<string>();
  for (const line of lines.slice(heading + 1)) {
    const match = /^- \[.+\]\((https:\/\/www\.robotto\.se\/products\/[a-zA-Z0-9_%~-]+)\/?\)$/.exec(line);
    if (!match || links.has(match[1])) throw new Error("INVALID_ROBOTTO_PRODUCT_LINK");
    links.add(match[1]);
  }
  return links;
}

async function readPublicCatalog(transport: typeof fetch) {
  const response = await transport(publicUrl, {
    cache: "no-store", redirect: "error",
    headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15_000),
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

export async function refreshRobottoOnlineStoreCatalog(
  storage: string | RobottoCatalogStorage, sessionShop: string, admin: AdminGraphqlClient | (() => Promise<AdminGraphqlClient>), transport = fetch,
) {
  if (sessionShop !== shop || (typeof storage === "string" && !isAbsolute(storage))) throw new Error("INVALID_PILOT_TARGET");
  const run = async () => refreshLockedCatalog(storage, typeof admin === "function" ? await admin() : admin, transport);
  return typeof storage === "string" ? withPublicationLock(storage, run) : storage.withLock(run);
}

async function refreshLockedCatalog(
  storage: string | RobottoCatalogStorage, admin: AdminGraphqlClient, transport: typeof fetch,
) {
  const response = await admin.graphql(`#graphql
    query RobottoOnlineStoreCatalogCount {
      shop { myshopifyDomain }
      productsCount(limit: null, query: "status:active published_status:online_store_channel") { count precision }
    }`);
  const result = await response.json();
  const total = result.data?.productsCount;
  if (!response.ok || result.errors?.length || result.data?.shop?.myshopifyDomain !== shop ||
      total?.precision !== "EXACT" || !Number.isSafeInteger(total.count) || total.count <= 0) {
    throw new Error("ROBOTTO_CATALOG_COUNT_UNVERIFIED");
  }
  const catalog = await generatePublicLlmCatalog(admin, "www.robotto.se", true);
  const candidate = Buffer.from(catalog.text);
  if (catalog.count !== total.count || candidate.length > limit) throw new Error("ROBOTTO_CATALOG_INCOMPLETE");
  const backup = await readPublicCatalog(transport);
  const previous = productLinks(backup);
  const next = productLinks(candidate);
  if (previous.size === next.size && [...next].every(link => previous.has(link))) {
    return { status: "UNCHANGED", sha256: sha(backup) } as const;
  }
  const input = { admin, transport, candidate, backup, expectedPreviousSha256: sha(backup) };
  return typeof storage === "string" ? persistBackupAndPublish(storage, input) : publishWithCloudBackup(storage, input);
}

async function publishWithCloudBackup(storage: RobottoCatalogStorage, input: PublicationInput) {
  const backup = await storage.persistBackup(input.backup, input.expectedPreviousSha256);
  return publishRobottoCatalog({ ...input, backup });
}

export async function runPreparedRobottoPilot(directory: string, sessionShop: string, admin: AdminGraphqlClient, storage?: RobottoCatalogStorage) {
  if (sessionShop !== shop || !isAbsolute(directory)) throw new Error("INVALID_PILOT_TARGET");
  const manifest = JSON.parse(await readFile(join(directory, "pilot.json"), "utf8")) as {
    previousSha256?: string;
    candidateSha256?: string;
  };
  if (!manifest.previousSha256 || !manifest.candidateSha256 ||
      !/^[a-f0-9]{64}$/.test(manifest.previousSha256) || !/^[a-f0-9]{64}$/.test(manifest.candidateSha256)) {
    throw new Error("INVALID_PILOT_MANIFEST");
  }
  const backup = await readFile(join(directory, "backup.txt"));
  const candidate = await readFile(join(directory, "candidate.txt"));
  if (sha(backup) !== manifest.previousSha256 || sha(candidate) !== manifest.candidateSha256) {
    throw new Error("PILOT_HASH_MISMATCH");
  }
  const marker = await open(join(directory, "pilot-attempted"), "wx", 0o600);
  try {
    await marker.sync();
  } finally {
    await marker.close();
  }
  const input = { admin, candidate, backup, expectedPreviousSha256: manifest.previousSha256 };
  return storage ? storage.withLock(() => publishWithCloudBackup(storage, input)) : publishRobottoCatalogWithBackup(directory, input);
}

export async function publishRobottoCatalogWithBackup(directory: string, input: PublicationInput) {
  return withPublicationLock(directory, () => persistBackupAndPublish(directory, input));
}

async function withPublicationLock<T>(directory: string, run: () => Promise<T>) {
  const lockPath = join(directory, "robotto-catalog-publication.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    return await run();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function persistBackupAndPublish(directory: string, input: PublicationInput) {
  const backup = Uint8Array.from(input.backup);
  const candidate = Uint8Array.from(input.candidate);
  const digest = sha(backup);
  if (backup.length > limit || digest !== input.expectedPreviousSha256) {
    throw new Error("INVALID_CATALOG_BACKUP");
  }

  const backupPath = join(directory, `robotto-llms-full.${digest}.txt`);
  const backupFile = await open(backupPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  if (backupFile) {
    try {
      await backupFile.writeFile(backup);
      await backupFile.sync();
    } finally {
      await backupFile.close();
    }
  }
  const stored = await readFile(backupPath);
  if (sha(stored) !== digest) throw new Error("PERSISTED_BACKUP_MISMATCH");
  return await publishRobottoCatalog({ ...input, candidate, backup: stored });
}

export async function publishRobottoCatalog(input: PublicationInput) {
  const { admin } = input;
  const candidate = Uint8Array.from(input.candidate);
  const backup = Uint8Array.from(input.backup);
  const transport = input.transport ?? fetch;
  const wait = input.wait ?? (() => new Promise(resolve => setTimeout(resolve, 3000)));
  const oldSha = sha(backup);
  const newSha = sha(candidate);
  const validCatalog = (bytes: Uint8Array) =>
    bytes.length <= limit && new TextDecoder().decode(bytes.subarray(0, 32)).startsWith("# www.robotto.se\n");
  if (!validCatalog(candidate) || !validCatalog(backup) || oldSha !== input.expectedPreviousSha256) {
    throw new Error("INVALID_CATALOG_OR_BACKUP");
  }

  async function query<T>(operation: string, variables: Record<string, unknown>): Promise<T> {
    const response = await admin.graphql(operation, { variables });
    if (!response.ok) throw new Error("SHOPIFY_HTTP_FAILED");
    const body = await response.json() as { data?: T; errors?: unknown[] };
    if (!body.data || body.errors?.length) throw new Error("SHOPIFY_GRAPHQL_FAILED");
    return body.data;
  }

  async function inspect() {
    const data = await query<{
      shop: { myshopifyDomain: string };
      currentAppInstallation: { accessScopes: { handle: string }[] } | null;
      node?: { id: string; fileStatus: string; url: string };
    }>(readCatalogFile, { id: fileId });
    const file = data.node;
    if (data.shop.myshopifyDomain !== shop || !file || file.id !== fileId) {
      throw new Error("SHOP_OR_FILE_MISMATCH");
    }
    if (!data.currentAppInstallation?.accessScopes.some(scope => scope.handle === "write_files")) {
      throw new Error("WRITE_FILES_NOT_GRANTED");
    }
    if (file.fileStatus !== "READY") return null;
    const url = URL.parse(file.url);
    if (!url || url.protocol !== "https:" || url.host !== "cdn.shopify.com" ||
        !url.pathname.endsWith("/files/llms-full.txt") || url.username || url.password || url.hash) {
      throw new Error("SHOPIFY_FILE_URL_MISMATCH");
    }
    return file;
  }

  async function readPublic() {
    return sha(await readPublicCatalog(transport));
  }

  async function stage(bytes: Uint8Array) {
    const data = await query<{ stagedUploadsCreate: {
      stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[];
      userErrors: unknown[];
    } }>(stageCatalog, { input: [{
      filename: "llms-full.txt", mimeType: "text/plain", resource: "FILE",
      httpMethod: "POST", fileSize: String(bytes.length),
    }] });
    const { stagedTargets, userErrors } = data.stagedUploadsCreate;
    if (userErrors.length || stagedTargets.length !== 1) throw new Error("STAGING_REJECTED");
    const target = stagedTargets[0];
    const upload = URL.parse(target.url);
    const resource = URL.parse(target.resourceUrl);
    if (!upload || !resource || [upload, resource].some(url =>
      url.protocol !== "https:" || url.host !== "shopify-staged-uploads.storage.googleapis.com" ||
      url.username || url.password || url.hash)) throw new Error("STAGING_TARGET_MISMATCH");

    const form = new FormData();
    for (const { name, value } of target.parameters) form.append(name, value);
    form.append("file", new Blob([Uint8Array.from(bytes)], { type: "text/plain" }), "llms-full.txt");
    const response = await transport(upload.href, {
      method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("STAGING_UPLOAD_FAILED");
    return resource.href;
  }

  async function replace(originalSource: string) {
    const result = await query<{ fileUpdate: { files: { id: string }[]; userErrors: unknown[] } }>(
      replaceCatalog, { files: [{ id: fileId, originalSource }] },
    );
    if (result.fileUpdate.userErrors.length || result.fileUpdate.files.length !== 1 ||
        result.fileUpdate.files[0].id !== fileId) throw new Error("FILE_UPDATE_REJECTED");
  }

  async function verify(expected: string) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await inspect() && await readPublic() === expected) return;
      if (attempt < 5) await wait();
    }
    throw new Error("PUBLIC_HASH_NOT_VERIFIED");
  }

  if (!await inspect()) throw new Error("FILE_NOT_READY");
  if (await readPublic() !== oldSha) throw new Error("PUBLIC_BASELINE_DRIFT");
  if (oldSha === newSha) return { status: "UNCHANGED", sha256: oldSha } as const;

  const next = await stage(candidate);
  const restore = await stage(backup);
  if (next === restore) throw new Error("STAGING_SOURCE_COLLISION");
  if (!await inspect() || await readPublic() !== oldSha) throw new Error("PUBLIC_BASELINE_DRIFT");
  try {
    await replace(next);
    await verify(newSha);
    return { status: "PUBLISHED", sha256: newSha } as const;
  } catch {
    // A timeout may hide a successful write. Only roll back a confirmed candidate.
    if (!await inspect() || await readPublic() !== newSha) {
      throw new Error("PUBLICATION_UNCONFIRMED");
    }
    await replace(restore);
    await verify(oldSha);
    return { status: "ROLLED_BACK", sha256: oldSha } as const;
  }
}
