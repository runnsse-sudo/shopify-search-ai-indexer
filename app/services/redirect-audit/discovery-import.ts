export type DiscoveryObservation = {
  path: string;
  reason?: string;
  httpStatus?: number;
  retryHttpStatus?: number;
  status: "DIRECT_404" | "UNVERIFIED" | "OTHER_RESPONSE";
};

export function isDiscoveryPath(path: string) {
  return path.length <= 512 &&
    !/%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path) &&
    /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:(?:products|collections|pages)\/[^/]+|blogs\/[^/]+\/[^/]+)$/.test(path);
}

export const discoveryImportLimit = 100;
export const discoveryInputLimit = 32_768;

export class DiscoveryInputError extends Error {}

export function parseDiscoveryUrls(input: string, origin: URL) {
  if (input.length > discoveryInputLimit) throw new DiscoveryInputError("URL list exceeds 32,768 characters.");

  const urls = new Set<string>();
  let ignored = 0;
  for (const line of input.split(/\r?\n/)) {
    // Search Console's Pages export puts the URL in the first CSV column.
    const first = line.trim().match(/^(?:"([^"]*)"|([^,\t]+))/);
    const raw = (first?.[1] ?? first?.[2] ?? "").trim();
    if (!raw || /^(url|webbadress)$/i.test(raw)) continue;

    try {
      const url = new URL(raw);
      if (
        url.origin !== origin.origin || url.username || url.password ||
        !isDiscoveryPath(url.pathname)
      ) {
        ignored++;
        continue;
      }
      urls.add(url.pathname);
    } catch {
      ignored++;
    }
  }

  if (urls.size > discoveryImportLimit) throw new DiscoveryInputError("Import at most 100 distinct storefront URLs per audit.");
  return { paths: [...urls], ignored };
}

export const queueFilters = ["PENDING", "UNVERIFIED", "DIRECT_404", "OTHER_RESPONSE"] as const;
