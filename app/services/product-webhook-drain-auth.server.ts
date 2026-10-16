import { createHash } from "node:crypto";
import { productWebhookAdminClient } from "./product-webhook-admin.ts";
import { resolvePrimaryShopDomain } from "./shop-info.server";
import { drainNeed, type DrainSpec } from "./product-webhook-drain-contract.ts";

export const DRAIN_AUTH_MIN_REMAINING_MS = 600000;
const REQUEST_MIN_REMAINING_MS = 360000;
export type DrainSessionMetadata = {
  id: string;
  shop: string;
  isOnline: boolean;
  scope: string | null;
  expires: Date | null;
};
export type DrainAuthMetadata = {
  domain: string;
  primaryDomain: string | null;
  sessions: DrainSessionMetadata[];
};
type PrivateSession = {
  id: string;
  shop: string;
  isOnline: boolean;
  scope?: string;
  expires?: Date;
  accessToken?: string;
  isScopeChanged: (scopes: string) => boolean;
};
function signature(m: DrainAuthMetadata) {
  return JSON.stringify({
    domain: m.domain,
    primaryDomain: m.primaryDomain,
    sessions: m.sessions.map((s) => ({
      id: s.id,
      shop: s.shop,
      isOnline: s.isOnline,
      scope: s.scope,
      expires: s.expires?.toISOString() ?? null,
    })),
  });
}
function gate(
  m: DrainAuthMetadata,
  now: Date,
  horizon: number,
  scopes: string,
) {
  drainNeed(
    Object.keys(m).sort().join() === "domain,primaryDomain,sessions" &&
      m.sessions.every(
        (s) =>
          Object.keys(s).sort().join() === "expires,id,isOnline,scope,shop",
      ),
    "AUTH_BLOCKED",
  );
  drainNeed(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(m.domain) &&
      m.primaryDomain &&
      m.sessions.length === 1,
    "AUTH_BLOCKED",
  );
  const s = m.sessions[0];
  drainNeed(
    s.id === `offline_${m.domain}` &&
      s.shop === m.domain &&
      s.isOnline === false,
    "AUTH_BLOCKED",
  );
  drainNeed(
    s.expires instanceof Date &&
      Number.isFinite(+s.expires) &&
      +s.expires > +now + horizon,
    "AUTH_REFRESH_REQUIRED",
  );
  const granted = new Set((s.scope ?? "").split(",").map((v) => v.trim()));
  for (const scope of [...granted])
    if (scope.startsWith("write_")) granted.add(`read_${scope.slice(6)}`);
  const required = new Set([
    "read_products",
    ...scopes
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  ]);
  drainNeed(
    [...required].every((scope) => granted.has(scope)),
    "AUTH_SCOPE_MISMATCH",
  );
}
export async function prepareProductWebhookDrainAuth(input: {
  spec: DrainSpec;
  requiredScopes: string;
  now: () => Date;
  readMetadata: () => Promise<DrainAuthMetadata>;
  loadSession: (id: string) => Promise<PrivateSession | undefined>;
  fetch: typeof fetch;
}) {
  const metadata = await input.readMetadata();
  gate(
    metadata,
    input.now(),
    DRAIN_AUTH_MIN_REMAINING_MS,
    input.requiredScopes,
  );
  drainNeed(
    metadata.primaryDomain === input.spec.context.primaryDomain &&
      metadata.domain === input.spec.context.domain,
    "AUTH_BLOCKED",
  );
  const session = await input.loadSession(metadata.sessions[0].id);
  drainNeed(
    session &&
      session.accessToken &&
      !session.isScopeChanged(input.requiredScopes),
    "AUTH_BLOCKED",
  );
  const pinned: DrainAuthMetadata = {
    domain: metadata.domain,
    primaryDomain: metadata.primaryDomain,
    sessions: [
      {
        id: session.id,
        shop: session.shop,
        isOnline: session.isOnline,
        scope: session.scope ?? null,
        expires: session.expires ? new Date(+session.expires) : null,
      },
    ],
  };
  gate(pinned, input.now(), DRAIN_AUTH_MIN_REMAINING_MS, input.requiredScopes);
  drainNeed(signature(metadata) === signature(pinned), "AUTH_SESSION_DRIFT");
  const accessToken = session.accessToken;
  const check = async () => {
    const fresh = await input.readMetadata();
    gate(fresh, input.now(), REQUEST_MIN_REMAINING_MS, input.requiredScopes);
    drainNeed(signature(fresh) === signature(pinned), "AUTH_SESSION_DRIFT");
  };
  const endpoint = `https://${metadata.domain}/admin/api/2026-07/graphql.json`;
  // Digests of the existing ShopPrimaryDomain and ProductForIndexing read queries
  // after removing comments/collapsing whitespace. A changed query fails closed.
  const domainQuery =
    "dd7e7f5b48f574770479b79c99147e756c74de8680d3f781c339320980620e32";
  const productQuery =
    "7e56b4fced4fe414056c49e7749a0e0aebbc6eda9965bcc1a066a2027948267c";
  const products = new Set(input.spec.manifest.map((r) => r.shopifyProductGid));
  let domainReads = 0,
    productReads = 0;
  const admin = productWebhookAdminClient(async (query, options) => {
    await check();
    drainNeed(
      !options ||
        Object.keys(options).every((k) =>
          ["variables", "tries", "signal"].includes(k),
        ),
      "AUTH_QUERY_BLOCKED",
    );
    const normal = query
      .replace(/#[^\r\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const hash = createHash("sha256").update(normal).digest("hex");
    if (hash === domainQuery)
      drainNeed(
        domainReads++ === 0 && productReads === 0 && !options?.variables,
        "AUTH_QUERY_BLOCKED",
      );
    else
      drainNeed(
        hash === productQuery &&
          domainReads === 1 &&
          productReads++ < 20 &&
          options?.variables &&
          Object.keys(options.variables).join() === "id" &&
          typeof options.variables.id === "string" &&
          products.has(options.variables.id),
        "AUTH_QUERY_BLOCKED",
      );
    const response = await input.fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        ...(options?.variables ? { variables: options.variables } : {}),
      }),
      signal: options?.signal,
    });
    if (!response.ok) throw { status: response.status };
    return response;
  });
  drainNeed(
    (await resolvePrimaryShopDomain(admin)) === metadata.primaryDomain,
    "AUTH_DOMAIN_DRIFT",
  );
  return { admin, check };
}
