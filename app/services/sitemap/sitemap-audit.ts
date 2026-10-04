import * as cheerio from "cheerio";

export type SitemapDocumentKind =
  | "INDEX"
  | "URLSET";

export type SitemapResourceType =
  | "PRODUCT"
  | "COLLECTION"
  | "PAGE"
  | "BLOG"
  | "ARTICLE"
  | "OTHER";

export type SitemapIndexEntry = {
  loc: string;
  lastmod: string | null;
};

export type SitemapUrlEntry = {
  loc: string;
  lastmod: string | null;
  images: string[];
};

export type ParsedSitemapDocument = {
  kind: SitemapDocumentKind;
  sourceUrl: string;
  sitemaps: SitemapIndexEntry[];
  urls: SitemapUrlEntry[];
};

function nonEmptyText(
  value: string | undefined,
) {
  const normalized =
    value?.trim() ?? "";

  return normalized || null;
}

export function parseSitemapXml(
  xml: string,
  sourceUrl: string,
): ParsedSitemapDocument {
  if (!xml.trim()) {
    throw new Error(
      "SITEMAP_XML_EMPTY",
    );
  }

  const $ =
    cheerio.load(
      xml,
      {
        xmlMode: true,
      },
    );

  const sitemapIndex =
    $("sitemapindex").first();

  if (sitemapIndex.length > 0) {
    const sitemaps =
      sitemapIndex
        .children("sitemap")
        .toArray()
        .flatMap((element) => {
          const loc =
            nonEmptyText(
              $(element)
                .children("loc")
                .first()
                .text(),
            );

          if (!loc) {
            return [];
          }

          return [
            {
              loc,
              lastmod:
                nonEmptyText(
                  $(element)
                    .children("lastmod")
                    .first()
                    .text(),
                ),
            },
          ];
        });

    return {
      kind: "INDEX",
      sourceUrl,
      sitemaps,
      urls: [],
    };
  }

  const urlset =
    $("urlset").first();

  if (urlset.length > 0) {
    const urls =
      urlset
        .children("url")
        .toArray()
        .flatMap((element) => {
          const node =
            $(element);

          const loc =
            nonEmptyText(
              node
                .children("loc")
                .first()
                .text(),
            );

          if (!loc) {
            return [];
          }

          const images =
            node
              .find("image\\:loc")
              .toArray()
              .map((imageElement) =>
                $(imageElement)
                  .text()
                  .trim(),
              )
              .filter(Boolean);

          return [
            {
              loc,
              lastmod:
                nonEmptyText(
                  node
                    .children("lastmod")
                    .first()
                    .text(),
                ),
              images,
            },
          ];
        });

    return {
      kind: "URLSET",
      sourceUrl,
      sitemaps: [],
      urls,
    };
  }

  throw new Error(
    "SITEMAP_XML_ROOT_UNSUPPORTED",
  );
}

export function classifySitemapUrl(
  value: string,
): SitemapResourceType {
  let parsed: URL;

  try {
    parsed =
      new URL(value);
  } catch {
    return "OTHER";
  }

  const rawSegments =
    parsed.pathname
      .split("/")
      .filter(Boolean);

  const localePrefix =
    /^[a-z]{2}(?:-[a-z]{2})?$/i;

  const segments =
    rawSegments.length >= 2 &&
    localePrefix.test(
      rawSegments[0],
    )
      ? rawSegments.slice(1)
      : rawSegments;

  if (segments[0] === "products") {
    return "PRODUCT";
  }

  if (segments[0] === "collections") {
    return "COLLECTION";
  }

  if (segments[0] === "pages") {
    return "PAGE";
  }

  if (segments[0] === "blogs") {
    if (
      segments.length >= 3 &&
      segments[2] !== "tagged"
    ) {
      return "ARTICLE";
    }

    return "BLOG";
  }

  return "OTHER";
}

export function normalizeComparableUrl(
  value: string,
): string | null {
  try {
    const parsed =
      new URL(value);

    parsed.hash = "";

    if (
      parsed.pathname.length > 1
    ) {
      parsed.pathname =
        parsed.pathname.replace(
          /\/+$/,
          "",
        );
    }

    return parsed.toString();
  } catch {
    return null;
  }
}
