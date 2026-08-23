export type IndexNowExecutionConfig =
  | { enabled: false }
  | {
    enabled: true;
    key: string;
    keyLocation: string;
    shopDomain: string | null;
    allowedHost: string | null;
  };

export function parseIndexNowExecutionConfig(
  env: Record<string, string | undefined>,
): IndexNowExecutionConfig {
  if (env.INDEXNOW_EXECUTION_ENABLED !== "true") return { enabled: false };
  const key = env.INDEXNOW_KEY?.trim();
  const keyLocation = env.INDEXNOW_KEY_LOCATION?.trim();
  if (!key) throw new Error("INDEXNOW_KEY is required when IndexNow execution is enabled");
  if (!keyLocation) {
    throw new Error("INDEXNOW_KEY_LOCATION is required when IndexNow execution is enabled");
  }
  if (!isValidIndexNowKey(key)) throw new Error("INDEXNOW_KEY is invalid");
  let parsedKeyLocation: URL;
  try {
    parsedKeyLocation = new URL(keyLocation);
  } catch {
    throw new Error("INDEXNOW_KEY_LOCATION is invalid");
  }
  if (
    parsedKeyLocation.protocol !== "https:" ||
    parsedKeyLocation.username ||
    parsedKeyLocation.password ||
    parsedKeyLocation.hash ||
    parsedKeyLocation.pathname !== `/${key}.txt`
  ) {
    throw new Error("INDEXNOW_KEY_LOCATION must be a valid HTTPS root key location");
  }
  const allowedHost = env.INDEXNOW_ALLOWED_HOST?.trim().toLowerCase() || null;
  if (allowedHost) {
    try {
      const parsedAllowedHost = new URL(`https://${allowedHost}`);
      if (parsedAllowedHost.host !== allowedHost || parsedAllowedHost.pathname !== "/") throw new Error();
    } catch {
      throw new Error("INDEXNOW_ALLOWED_HOST is invalid");
    }
  }
  return {
    enabled: true,
    key,
    keyLocation,
    shopDomain: env.INDEXNOW_SHOP_DOMAIN?.trim() || null,
    allowedHost,
  };
}

export function sanitizeIndexNowConfig(config: IndexNowExecutionConfig) {
  if (!config.enabled) return config;
  return {
    enabled: true as const,
    keyConfigured: true,
    keyLocationConfigured: true,
    shopDomain: config.shopDomain,
    allowedHost: config.allowedHost,
  };
}
import { isValidIndexNowKey } from "./indexnow-verification.ts";
