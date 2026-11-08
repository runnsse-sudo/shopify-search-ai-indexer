import type { AdminGraphqlClient } from "../shopify-product.server";
import { CATALOG_SHOPS, validateCatalogTarget } from "./multishop-catalog-targets.ts";

export const setupIdentityQuery = `query CatalogSetupIdentity {
  shop { myshopifyDomain primaryDomain { host } }
  currentAppInstallation { accessScopes { handle } }
}`;
export const setupFilesQuery = `query CatalogSetupFiles {
  files(first: 2, query: "filename:llms-full.txt") {
    nodes { ... on GenericFile { id fileStatus url } }
    pageInfo { hasNextPage }
  }
}`;
const robottoFileId = "gid://shopify/GenericFile/62861370655066";
type FileNode = { id: string; fileStatus: string; url: string };

// Preparation only: no mutation, scope request, storage writer or worker dependency.
export async function inspectCatalogSetup(shop: string, admin: AdminGraphqlClient) {
  if (!CATALOG_SHOPS.some((allowed) => allowed === shop))
    throw new Error("CATALOG_SHOP_NOT_ALLOWED");
  async function read(query: string) {
    const response = await admin.graphql(query);
    if (!response.ok) throw new Error("CATALOG_SETUP_READ_FAILED");
    const body = await response.json();
    if (!body.data || body.errors?.length)
      throw new Error("CATALOG_SETUP_READ_FAILED");
    return body.data;
  }
  const identity = await read(setupIdentityQuery);
  if (identity.shop?.myshopifyDomain !== shop)
    throw new Error("CATALOG_SETUP_SHOP_MISMATCH");
  const primaryDomain: string = identity.shop?.primaryDomain?.host;
  if (typeof primaryDomain !== "string" || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(primaryDomain))
    throw new Error("CATALOG_SETUP_DOMAIN_UNVERIFIED");
  if (shop === "robotto-7143.myshopify.com" && primaryDomain !== "www.robotto.se")
    throw new Error("CATALOG_SETUP_EXISTING_DOMAIN_DRIFT");
  const scopes = identity.currentAppInstallation?.accessScopes;
  if (!Array.isArray(scopes) || scopes.some((s: {handle?: unknown}) => !s || typeof s.handle !== "string"))
    throw new Error("CATALOG_SETUP_SCOPES_UNVERIFIED");
  const writeFiles = scopes.some((s: {handle: string}) => s.handle === "write_files");
  const canReadFiles = writeFiles || scopes.some((s: {handle: string}) => s.handle === "read_files");
  let file: { fileId: string; cdnPath: string } | null = null;
  let fileStatus = "FILE_ACCESS_REQUIRED";
  if (canReadFiles) {
    const data = await read(setupFilesQuery);
    const connection = data.files;
    if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean")
      throw new Error("CATALOG_SETUP_FILES_UNVERIFIED");
    const nodes: FileNode[] = connection.nodes;
    if (nodes.length > 1 || connection.pageInfo.hasNextPage) {
      fileStatus = "AMBIGUOUS_FILES_REVIEW_REQUIRED";
    } else if (nodes.length === 0) {
      fileStatus = "INITIAL_FILE_REQUIRED";
    } else {
      const node = nodes[0];
      const url = typeof node?.url === "string" ? URL.parse(node.url) : null;
      if (!url || url.protocol !== "https:" || url.hostname !== "cdn.shopify.com" || url.port || url.username || url.password || url.hash || !/^\?v=[0-9]+$/.test(url.search))
        throw new Error("CATALOG_SETUP_FILE_BINDING_UNVERIFIED");
      const target = validateCatalogTarget({ shop, primaryDomain, fileId: node.id, cdnPath: url.pathname });
      if (shop === "robotto-7143.myshopify.com" && (node.id !== robottoFileId || target.cdnPath !== "/s/files/1/0766/2777/1738/files/llms-full.txt"))
        throw new Error("CATALOG_SETUP_EXISTING_BINDING_DRIFT");
      file = { fileId: target.fileId, cdnPath: target.cdnPath };
      fileStatus = node.fileStatus === "READY" ? "EXISTING_FILE_READY" : "FILE_NOT_READY";
    }
  }
  return {
    schemaVersion: 1,
    shop,
    primaryDomain,
    observedAt: new Date().toISOString(),
    mode: "PREPARATION_ONLY" as const,
    fileAccess: writeFiles ? "GRANTED" : "REQUIRES_MERCHANT_CONSENT",
    fileStatus,
    target: file ? { shop, primaryDomain, ...file } : null,
    initialPublication: {
      operation: fileStatus === "INITIAL_FILE_REQUIRED" ? "PROPOSE_INITIAL_FILE" : "NO_AUTOMATIC_OPERATION",
      filename: "llms-full.txt",
      publicPath: "/llms-full.txt",
      theme: { id: null, role: "MAIN", status: "READ_ONLY_VERIFICATION_REQUIRED" },
      template: "templates/llms-full.txt.liquid",
      templateOwnership: "UNKNOWN",
      existingTemplateSha256: null,
      backup: "VERIFY_FILE_AND_TEMPLATE_BYTES_SHA256_BEFORE_ANY_REPLACEMENT",
      rollback: file ? "RESTORE_EXACT_PINNED_FILE_AND_TEMPLATE_FROM_VERIFIED_BACKUP" : "REMOVE_ONLY_OWN_NEW_ARTIFACTS_AFTER_SEPARATE_APPROVAL",
      protectedPaths: ["/agents.md", "/llms.txt"],
      separateApprovalRequired: true,
    },
    activation: {
      ready: false,
      offlineSession: "NOT_VERIFIED",
      storageIam: "NOT_VERIFIED",
      schedule: "NOT_ENABLED",
      blockers: [
        ...(!writeFiles ? ["WRITE_FILES_CONSENT_REQUIRED"] : []),
        ...(fileStatus !== "EXISTING_FILE_READY" ? [fileStatus] : []),
        "THEME_OWNERSHIP_AND_BACKUP_REVIEW_REQUIRED",
        "OFFLINE_SESSION_AND_STORAGE_QUALIFICATION_REQUIRED",
        "SEPARATE_PILOT_COST_AND_ACTIVATION_APPROVAL_REQUIRED",
      ],
    },
    writesPerformed: 0,
  };
}
