import { createHash } from "node:crypto";
import type { AdminGraphqlClient } from "../shopify-product.server";
import {
  felkCatalogAddress,
  felkCatalogUrls,
  verifyFelkCatalogAddress,
} from "./felk-catalog-address.ts";
import {
  stageCatalog,
  readCatalogFile,
} from "./robotto-catalog-publication.server.ts";
import {
  CatalogVerificationError,
  type CatalogPhase,
} from "./robotto-catalog-diagnostics.ts";

export const createFelkCatalog = `mutation CreateFelkCatalog($files: [FileCreateInput!]!) {
  fileCreate(files: $files) { files { id } userErrors { field } }
}`;

const shop = "94d715-94.myshopify.com";
const limit = 8 * 1024 * 1024;

// Called only inside the existing publisher's lock, after verified durable backup.
// No fileUpdate, fileDelete, theme write or checkpoint write is available here.
export async function createFelkCatalogCandidate(input: {
  admin: AdminGraphqlClient;
  candidate: Uint8Array;
  transport: typeof fetch;
  wait: () => Promise<void>;
  onPhase: (phase: CatalogPhase) => void;
  expectedLegacyUrl: string;
}) {
  const bytes = Uint8Array.from(input.candidate);
  const plan = felkCatalogAddress(shop, bytes);
  const { admin, transport, wait, onPhase } = input;
  async function query(operation: string, variables: Record<string, unknown>) {
    const response = await admin.graphql(operation, { variables });
    if (!response.ok) throw new Error("SHOPIFY_HTTP_FAILED");
    const body = await response.json();
    if (!body.data || body.errors?.length)
      throw new Error("SHOPIFY_GRAPHQL_FAILED");
    return body.data;
  }

  // Recheck tenant/scope immediately before staging. The enclosing publisher
  // separately verifies the previous file and both delivery paths before backup.
  const identity = await query(readCatalogFile, { id: plan.previousFileId });
  if (
    identity.shop?.myshopifyDomain !== shop ||
    identity.node?.id !== plan.previousFileId
  )
    throw new Error("SHOP_OR_FILE_MISMATCH");
  if (
    identity.node.fileStatus !== "READY" ||
    identity.node.url !== input.expectedLegacyUrl
  )
    throw new Error("PUBLIC_FILE_VERSION_DRIFT");
  if (
    !identity.currentAppInstallation?.accessScopes?.some(
      (s: { handle: string }) => s.handle === "write_files",
    )
  )
    throw new Error("WRITE_FILES_NOT_GRANTED");

  onPhase("stage");
  const data = await query(stageCatalog, {
    input: [
      {
        filename: plan.filename,
        mimeType: "text/plain",
        resource: "FILE",
        httpMethod: "POST",
        fileSize: String(bytes.length),
      },
    ],
  });
  const staged = data.stagedUploadsCreate;
  if (
    !staged ||
    staged.userErrors?.length ||
    staged.stagedTargets?.length !== 1
  )
    throw new Error("STAGING_REJECTED");
  const target = staged.stagedTargets[0];
  const upload = new URL(target.url);
  const resource = new URL(target.resourceUrl);
  if (
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
  for (const parameter of target.parameters)
    form.append(parameter.name, parameter.value);
  form.append("file", new Blob([bytes], { type: "text/plain" }), plan.filename);
  onPhase("upload");
  const uploaded = await transport(upload.href, {
    method: "POST",
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!uploaded.ok) throw new Error("STAGING_UPLOAD_FAILED");

  onPhase("file_create");
  // Exactly one attempt: an HTTP failure/timeout may hide a successful creation.
  const created = await query(createFelkCatalog, {
    files: [
      {
        ...plan.createInput,
        originalSource: resource.href,
      },
    ],
  });
  if (
    created.fileCreate?.userErrors?.length ||
    created.fileCreate?.files?.length !== 1
  )
    throw new Error("FILE_CREATE_REJECTED");
  const id = created.fileCreate.files[0].id;
  if (
    typeof id !== "string" ||
    !/^gid:\/\/shopify\/GenericFile\/[1-9][0-9]*$/.test(id) ||
    id === plan.previousFileId
  )
    throw new Error("SHOP_OR_FILE_MISMATCH");

  async function metadata() {
    onPhase("file_metadata");
    const result = await query(readCatalogFile, { id });
    if (result.shop?.myshopifyDomain !== shop || result.node?.id !== id)
      throw new Error("SHOP_OR_FILE_MISMATCH");
    const file = result.node;
    if (file.fileStatus === "UPLOADED" || file.fileStatus === "PROCESSING")
      return null;
    const value = { shop, id, status: file.fileStatus, url: file.url };
    felkCatalogUrls(plan, value);
    return value;
  }
  async function read(url: string) {
    onPhase("public_read");
    const response = await transport(url, {
      redirect: "error",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) throw new Error("PUBLIC_READ_FAILED");
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return Buffer.concat(chunks, length);
        length += value.length;
        if (length > limit || length > plan.bytes) {
          await reader.cancel();
          throw new Error("PUBLIC_FILE_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  let expectedVersion: string | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = await metadata();
    if (before) {
      if (expectedVersion !== undefined && before.url !== expectedVersion)
        throw new Error("PUBLIC_FILE_VERSION_DRIFT");
      expectedVersion = before.url;
      const urls = felkCatalogUrls(plan, before);
      const canonical = await read(urls.canonical);
      const download = await read(urls.download);
      const after = await metadata();
      if (!after) throw new Error("PUBLIC_FILE_VERSION_DRIFT");
      onPhase("public_verify");
      try {
        const verified = verifyFelkCatalogAddress({
          sessionShop: shop,
          candidate: bytes,
          before,
          after,
          canonical,
          download,
        });
        return {
          status: "CANDIDATE_READY",
          fileId: id,
          sha256: plan.sha256,
          canonical: verified.canonical,
          download: verified.download,
          filename: plan.filename,
          linkChangeRequired: true,
          previousFileId: plan.previousFileId,
        } as const;
      } catch (error: unknown) {
        if (
          !(error instanceof Error) ||
          error.message !== "PUBLIC_HASH_NOT_VERIFIED"
        )
          throw error;
        if (attempt === 5) {
          const hash = (value: Uint8Array) =>
            createHash("sha256").update(value).digest("hex");
          throw new CatalogVerificationError("PUBLIC_HASH_NOT_VERIFIED", {
            observedAt: new Date().toISOString(),
            canonicalSha256: hash(canonical),
            downloadSha256: hash(download),
            canonicalBytes: canonical.length,
            downloadBytes: download.length,
            beforeVersion: new URL(before.url).searchParams.get("v")!,
            afterVersion: new URL(after.url).searchParams.get("v")!,
          });
        }
      }
    }
    if (attempt < 5) await wait();
  }
  throw new Error("PUBLIC_HASH_NOT_VERIFIED");
}

// A rollback must never overwrite an intervening merchant/theme edit.
export function restoreFelkCatalogLink(
  current: string,
  patch: ReturnType<typeof felkCatalogLinkChange>,
) {
  const hash = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");
  if (
    patch.filename !== "templates/llms-full.txt.liquid" ||
    hash(current) !== patch.afterSha256 ||
    current !== patch.after ||
    patch.rollback.expectedCurrentSha256 !== patch.afterSha256 ||
    hash(patch.rollback.restore) !== patch.beforeSha256 ||
    patch.rollback.restore !== patch.before
  )
    throw new Error("CATALOG_TEMPLATE_DRIFT");
  return patch.rollback.restore;
}

// Local, exact-match review artifact. It does not write a theme or grant access.
export function felkCatalogLinkChange(input: {
  template: string;
  expectedSha256: string;
  previousUrl: string;
  candidate: Uint8Array;
  metadata: { shop: string; id: string; status: string; url: string };
}) {
  const plan = felkCatalogAddress(shop, input.candidate);
  const urls = felkCatalogUrls(plan, input.metadata);
  const old = new URL(input.previousUrl);
  if (
    old.origin !== "https://www.felkodslasare.se" ||
    old.pathname !== "/cdn/shop/files/llms-full.txt" ||
    !/^\?v=[0-9]+$/.test(old.search) ||
    old.username ||
    old.password ||
    old.hash ||
    old.href !== input.previousUrl
  )
    throw new Error("CATALOG_URL_MISMATCH");
  const hash = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  if (
    Buffer.byteLength(input.template, "utf8") > 128 * 1024 ||
    !/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
    hash(input.template) !== input.expectedSha256
  )
    throw new Error("CATALOG_TEMPLATE_DRIFT");
  const first = input.template.indexOf(old.href);
  if (
    first < 0 ||
    input.template.indexOf(old.href, first + old.href.length) !== -1 ||
    input.template.includes(urls.download)
  )
    throw new Error("CATALOG_TEMPLATE_AMBIGUOUS");
  const replacement = input.template.replace(old.href, urls.download);
  return Object.freeze({
    filename: "templates/llms-full.txt.liquid",
    before: input.template,
    after: replacement,
    beforeSha256: input.expectedSha256,
    afterSha256: hash(replacement),
    previousUrl: old.href,
    nextUrl: urls.download,
    candidateSha256: plan.sha256,
    rollback: Object.freeze({
      expectedCurrentSha256: hash(replacement),
      restore: input.template,
    }),
    status: "REVIEW_ONLY",
    requiresSeparateThemeAuthorization: true,
  });
}
