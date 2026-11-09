import { createHash } from "node:crypto";

const shop = "94d715-94.myshopify.com";
const domain = "www.felkodslasare.se";
const directory = "/s/files/1/0746/4979/6876/files/";
const previousId = "gid://shopify/GenericFile/77579264491788";
const limit = 8 * 1024 * 1024;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Pure preparation only: no upload, pointer change, lock or storage operation. */
export function felkCatalogAddress(sessionShop: string, bytes: Uint8Array) {
  if (sessionShop !== shop) throw new Error("CATALOG_TENANT_MISMATCH");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    !bytes.length ||
    bytes.length > limit ||
    !text.startsWith(`# ${domain}\n`)
  )
    throw new Error("INVALID_CATALOG");
  const digest = sha(bytes);
  const filename = `llms-full-${digest}.txt`;
  return Object.freeze({
    shop,
    sha256: digest,
    bytes: bytes.length,
    filename,
    canonicalPath: directory + filename,
    downloadPath: `/cdn/shop/files/${filename}`,
    // Never REPLACE or APPEND_UUID: both break content-address identity.
    createInput: Object.freeze({
      filename,
      contentType: "FILE",
      duplicateResolutionMode: "RAISE_ERROR",
    }),
    previousFileId: previousId,
    lockObject: `shops/${shop}/llms-full/publication.lock`,
  });
}

type Metadata = { shop: string; id: string; status: string; url: string };

/** Validate metadata before fetching either URL; redirects must remain disabled. */
export function felkCatalogUrls(
  plan: ReturnType<typeof felkCatalogAddress>,
  metadata: Metadata,
) {
  const url = new URL(metadata.url);
  if (
    metadata.shop !== shop ||
    !/^gid:\/\/shopify\/GenericFile\/[0-9]+$/.test(metadata.id) ||
    metadata.id === previousId ||
    metadata.status !== "READY" ||
    url.origin !== "https://cdn.shopify.com" ||
    url.pathname !== plan.canonicalPath ||
    !/^\?v=[0-9]+$/.test(url.search) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("CONTENT_ADDRESS_METADATA_MISMATCH");
  return Object.freeze({
    canonical: url.href,
    download: `https://${domain}${plan.downloadPath}${url.search}`,
  });
}

/** Both delivery paths and stable metadata are mandatory, even for SHA filenames. */
export function verifyFelkCatalogAddress(input: {
  candidate: Uint8Array;
  sessionShop: string;
  before: Metadata;
  after: Metadata;
  canonical: Uint8Array;
  download: Uint8Array;
}) {
  const plan = felkCatalogAddress(input.sessionShop, input.candidate);
  const urls = felkCatalogUrls(plan, input.before);
  felkCatalogUrls(plan, input.after);
  if (
    input.before.id !== input.after.id ||
    input.before.url !== input.after.url
  )
    throw new Error("PUBLIC_FILE_VERSION_DRIFT");
  if (
    input.canonical.length !== plan.bytes ||
    input.download.length !== plan.bytes ||
    sha(input.canonical) !== plan.sha256 ||
    sha(input.download) !== plan.sha256
  )
    throw new Error("PUBLIC_HASH_NOT_VERIFIED");
  return Object.freeze({ status: "VERIFIED_CANDIDATE", ...plan, ...urls });
}
