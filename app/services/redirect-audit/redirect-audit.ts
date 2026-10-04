import * as cheerio from "cheerio";

import {
  classifySitemapUrl,
  normalizeComparableUrl,
  type SitemapResourceType,
} from "../sitemap/sitemap-audit";

export type RedirectConfidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW";

export type RedirectSuggestion = {
  targetUrl: string;
  confidence: RedirectConfidence;
  score: number;
  reason: string;
};

function normalizeHost(
  value: string,
) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function normalizeSameHostUrl(
  raw: string,
  baseUrl: string,
  allowedHost: string,
  stripSearch: boolean,
): string | null {
  try {
    const parsed =
      new URL(
        raw.trim(),
        baseUrl,
      );

    if (
      parsed.protocol !== "https:"
    ) {
      return null;
    }

    if (
      parsed.username ||
      parsed.password
    ) {
      return null;
    }

    if (
      normalizeHost(
        parsed.hostname,
      ) !==
      normalizeHost(
        allowedHost,
      )
    ) {
      return null;
    }

    parsed.hash = "";

    if (stripSearch) {
      parsed.search = "";
    }

    return normalizeComparableUrl(
      parsed.toString(),
    );
  } catch {
    return null;
  }
}

export function normalizeInternalUrl(
  raw: string,
  baseUrl: string,
  allowedHost: string,
): string | null {
  return normalizeSameHostUrl(
    raw,
    baseUrl,
    allowedHost,
    true,
  );
}

export function normalizeSitemapDocumentUrl(
  raw: string,
  baseUrl: string,
  allowedHost: string,
): string | null {
  return normalizeSameHostUrl(
    raw,
    baseUrl,
    allowedHost,
    false,
  );
}

export function extractInternalLinks(
  html: string,
  pageUrl: string,
  allowedHost: string,
): string[] {
  const $ =
    cheerio.load(html);

  const links =
    new Set<string>();

  $("a[href]").each(
    (_, element) => {
      const href =
        $(element)
          .attr("href")
          ?.trim();

      if (!href) {
        return;
      }

      const normalized =
        normalizeInternalUrl(
          href,
          pageUrl,
          allowedHost,
        );

      if (normalized) {
        links.add(normalized);
      }
    },
  );

  return Array.from(links);
}

function localeKey(
  value: string,
) {
  try {
    const segments =
      new URL(value)
        .pathname
        .split("/")
        .filter(Boolean);

    const localePrefix =
      /^[a-z]{2}(?:-[a-z]{2})?$/i;

    if (
      segments.length >= 2 &&
      localePrefix.test(
        segments[0],
      )
    ) {
      return segments[0]
        .toLowerCase();
    }

    return "DEFAULT";
  } catch {
    return "INVALID";
  }
}

function pathSegments(
  value: string,
) {
  try {
    const parsed =
      new URL(value);

    const segments =
      parsed.pathname
        .split("/")
        .filter(Boolean);

    const localePrefix =
      /^[a-z]{2}(?:-[a-z]{2})?$/i;

    if (
      segments.length >= 2 &&
      localePrefix.test(
        segments[0],
      )
    ) {
      return segments.slice(1);
    }

    return segments;
  } catch {
    return [];
  }
}

function tokenSet(
  value: string,
) {
  const segments =
    pathSegments(value);

  const tokens =
    segments
      .flatMap((segment) =>
        decodeURIComponent(
          segment,
        )
          .toLowerCase()
          .split(/[-_+.]+/)
          .filter(
            (token) =>
              token.length >= 2,
          ),
      );

  return new Set(tokens);
}

function lastSegment(
  value: string,
) {
  const segments =
    pathSegments(value);

  return (
    segments.at(-1) ??
    ""
  ).toLowerCase();
}

function firstSegment(
  value: string,
) {
  return (
    pathSegments(value)[0] ??
    ""
  ).toLowerCase();
}

function overlapScore(
  left: Set<string>,
  right: Set<string>,
) {
  if (
    left.size === 0 ||
    right.size === 0
  ) {
    return 0;
  }

  let intersection =
    0;

  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union =
    new Set([
      ...left,
      ...right,
    ]).size;

  return union === 0
    ? 0
    : intersection / union;
}

function confidenceForScore(
  score: number,
): RedirectConfidence | null {
  if (score >= 85) {
    return "HIGH";
  }

  if (score >= 65) {
    return "MEDIUM";
  }

  if (score >= 45) {
    return "LOW";
  }

  return null;
}

export function suggestRedirect(
  missingUrl: string,
  candidateUrls: string[],
): RedirectSuggestion | null {
  const normalizedMissing =
    normalizeComparableUrl(
      missingUrl,
    );

  if (!normalizedMissing) {
    return null;
  }

  const missingType =
    classifySitemapUrl(
      normalizedMissing,
    );

  const missingTokens =
    tokenSet(
      normalizedMissing,
    );

  const missingSlug =
    lastSegment(
      normalizedMissing,
    );

  const missingFirst =
    firstSegment(
      normalizedMissing,
    );

  const missingLocale =
    localeKey(
      normalizedMissing,
    );

  let best:
    RedirectSuggestion | null =
      null;

  for (
    const rawCandidate
    of candidateUrls
  ) {
    const candidate =
      normalizeComparableUrl(
        rawCandidate,
      );

    if (
      !candidate ||
      candidate ===
        normalizedMissing
    ) {
      continue;
    }

    const candidateLocale =
      localeKey(
        candidate,
      );

    if (
      candidateLocale !==
      missingLocale
    ) {
      continue;
    }

    const candidateType:
      SitemapResourceType =
        classifySitemapUrl(
          candidate,
        );

    const candidateTokens =
      tokenSet(candidate);

    const candidateSlug =
      lastSegment(candidate);

    const candidateFirst =
      firstSegment(candidate);

    let score =
      0;

    const reasons:
      string[] = [];

    if (
      missingType !== "OTHER" &&
      candidateType ===
        missingType
    ) {
      score += 50;

      reasons.push(
        "same resource type",
      );
    }

    if (
      missingFirst &&
      candidateFirst ===
        missingFirst
    ) {
      score += 10;

      reasons.push(
        "same path section",
      );
    }

    if (
      missingSlug &&
      candidateSlug ===
        missingSlug
    ) {
      score += 35;

      reasons.push(
        "same final slug",
      );
    }

    const overlap =
      overlapScore(
        missingTokens,
        candidateTokens,
      );

    if (overlap > 0) {
      const tokenPoints =
        Math.round(
          overlap * 30,
        );

      score += tokenPoints;

      reasons.push(
        `path token overlap ${Math.round(
          overlap * 100,
        )}%`,
      );
    }

    score =
      Math.min(
        score,
        100,
      );

    const confidence =
      confidenceForScore(
        score,
      );

    if (!confidence) {
      continue;
    }

    const suggestion:
      RedirectSuggestion = {
        targetUrl:
          candidate,
        confidence,
        score,
        reason:
          reasons.join(", "),
      };

    if (
      !best ||
      suggestion.score >
        best.score ||
      (
        suggestion.score ===
          best.score &&
        suggestion.targetUrl <
          best.targetUrl
      )
    ) {
      best =
        suggestion;
    }
  }

  return best;
}