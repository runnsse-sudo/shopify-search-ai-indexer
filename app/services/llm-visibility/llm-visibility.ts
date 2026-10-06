export type AiCrawlerPurpose =
  | "SEARCH"
  | "TRAINING"
  | "GENERATIVE_AI_CONTROL";

export type AiCrawlerDefinition = {
  token: string;
  vendor: string;
  purpose: AiCrawlerPurpose;
  searchVisibilityRelevant: boolean;
};

export const AI_CRAWLERS:
  readonly AiCrawlerDefinition[] = [
    {
      token: "OAI-SearchBot",
      vendor: "OpenAI",
      purpose: "SEARCH",
      searchVisibilityRelevant: true,
    },
    {
      token: "GPTBot",
      vendor: "OpenAI",
      purpose: "TRAINING",
      searchVisibilityRelevant: false,
    },
    {
      token: "Claude-SearchBot",
      vendor: "Anthropic",
      purpose: "SEARCH",
      searchVisibilityRelevant: true,
    },
    {
      token: "ClaudeBot",
      vendor: "Anthropic",
      purpose: "TRAINING",
      searchVisibilityRelevant: false,
    },
    {
      token: "PerplexityBot",
      vendor: "Perplexity",
      purpose: "SEARCH",
      searchVisibilityRelevant: true,
    },
    {
      token: "Google-Extended",
      vendor: "Google",
      purpose:
        "GENERATIVE_AI_CONTROL",
      searchVisibilityRelevant: false,
    },
  ];

export type RobotsRule = {
  directive:
    | "ALLOW"
    | "DISALLOW";
  pattern: string;
};

export type RobotsGroup = {
  userAgents: string[];
  rules: RobotsRule[];
};

export type ParsedRobotsTxt = {
  groups: RobotsGroup[];
  sitemaps: string[];
};

export type RobotsAccess =
  | "ALLOW"
  | "DISALLOW";

export type LlmsDocumentAnalysis = {
  bytes: number;
  nonEmpty: boolean;
  lineCount: number;
  headingCount: number;
  h1Count: number;
  markdownLinkCount: number;
  absoluteUrlCount: number;
  structured: boolean;
};

export type LlmVisibilityScoreInput = {
  robotsStatusCode:
    number | null;

  searchCrawlerAccess:
    Array<{
      token: string;

      allRepresentativePathsAllowed:
        boolean;

      rootAllowed:
        boolean;
    }>;

  robotsSitemapCount:
    number;

  llmsTxtPresent:
    boolean;

  llmsFullTxtPresent:
    boolean;

  sampledNoindex:
    number;

  sampledCanonicalMismatch:
    number;
};


function stripComment(
  value: string,
) {
  const hash =
    value.indexOf("#");

  return (
    hash >= 0
      ? value.slice(
          0,
          hash,
        )
      : value
  ).trim();
}


export function parseRobotsTxt(
  text: string,
): ParsedRobotsTxt {
  const normalized =
    text.replace(
      /^\uFEFF/,
      "",
    );

  const groups:
    RobotsGroup[] = [];

  const sitemaps:
    string[] = [];

  let current:
    RobotsGroup | null =
      null;

  let currentHasRules =
    false;


  const flush = () => {
    if (
      current &&
      current.userAgents.length >
        0
    ) {
      groups.push(
        current,
      );
    }

    current = null;
    currentHasRules = false;
  };


  for (
    const rawLine
    of normalized.split(
      /\r?\n/,
    )
  ) {
    const line =
      stripComment(
        rawLine,
      );

    if (!line) {
      continue;
    }

    const separator =
      line.indexOf(":");

    if (separator < 0) {
      continue;
    }

    const key =
      line
        .slice(
          0,
          separator,
        )
        .trim()
        .toLowerCase();

    const value =
      line
        .slice(
          separator + 1,
        )
        .trim();


    if (key === "sitemap") {
      if (value) {
        sitemaps.push(
          value,
        );
      }

      continue;
    }


    if (
      key ===
      "user-agent"
    ) {
      if (!value) {
        continue;
      }

      if (
        !current ||
        currentHasRules
      ) {
        flush();

        current = {
          userAgents: [],
          rules: [],
        };
      }

      current.userAgents.push(
        value.toLowerCase(),
      );

      continue;
    }


    if (
      key !== "allow" &&
      key !== "disallow"
    ) {
      continue;
    }


    if (
      !current ||
      current.userAgents.length ===
        0
    ) {
      continue;
    }


    currentHasRules =
      true;

    current.rules.push({
      directive:
        key === "allow"
          ? "ALLOW"
          : "DISALLOW",

      pattern:
        value,
    });
  }


  flush();


  return {
    groups,

    sitemaps:
      Array.from(
        new Set(
          sitemaps,
        ),
      ),
  };
}


function escapeRegex(
  value: string,
) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}


function ruleMatches(
  pattern: string,
  targetPath: string,
) {
  if (!pattern) {
    return false;
  }

  const endAnchored =
    pattern.endsWith(
      "$",
    );

  const body =
    endAnchored
      ? pattern.slice(
          0,
          -1,
        )
      : pattern;

  const regexSource =
    escapeRegex(
      body,
    ).replace(
      /\\\*/g,
      ".*",
    );

  const expression =
    new RegExp(
      `^${regexSource}${
        endAnchored
          ? "$"
          : ""
      }`,
    );

  return expression.test(
    targetPath,
  );
}


function ruleSpecificity(
  pattern: string,
) {
  return pattern
    .replace(
      /\*/g,
      "",
    )
    .replace(
      /\$$/,
      "",
    )
    .length;
}


export function evaluateRobotsAccess(
  parsed: ParsedRobotsTxt,
  crawlerToken: string,
  targetPath: string,
): RobotsAccess {
  const token =
    crawlerToken
      .trim()
      .toLowerCase();

  const normalizedPath =
    targetPath.startsWith(
      "/",
    )
      ? targetPath
      : `/${targetPath}`;


  const specificGroups =
    parsed.groups.filter(
      (group) =>
        group.userAgents.includes(
          token,
        ),
    );


  const selectedGroups =
    specificGroups.length >
    0
      ? specificGroups
      : parsed.groups.filter(
          (group) =>
            group.userAgents.includes(
              "*",
            ),
        );


  let winner:
    {
      directive:
        RobotsRule[
          "directive"
        ];

      specificity:
        number;
    } | null =
      null;


  for (
    const group
    of selectedGroups
  ) {
    for (
      const rule
      of group.rules
    ) {
      if (
        rule.directive ===
          "DISALLOW" &&
        rule.pattern ===
          ""
      ) {
        continue;
      }

      if (
        !ruleMatches(
          rule.pattern,
          normalizedPath,
        )
      ) {
        continue;
      }

      const specificity =
        ruleSpecificity(
          rule.pattern,
        );

      if (
        !winner ||
        specificity >
          winner.specificity ||
        (
          specificity ===
            winner.specificity &&
          rule.directive ===
            "ALLOW" &&
          winner.directive ===
            "DISALLOW"
        )
      ) {
        winner = {
          directive:
            rule.directive,

          specificity,
        };
      }
    }
  }


  return winner?.directive ===
    "DISALLOW"
    ? "DISALLOW"
    : "ALLOW";
}


export function analyzeLlmsDocument(
  text: string,
): LlmsDocumentAnalysis {
  const normalized =
    text.trim();

  const lines =
    normalized
      ? normalized.split(
          /\r?\n/,
        )
      : [];


  const headingCount =
    lines.filter(
      (line) =>
        /^#{1,6}\s+\S/.test(
          line.trim(),
        ),
    ).length;


  const h1Count =
    lines.filter(
      (line) =>
        /^#\s+\S/.test(
          line.trim(),
        ),
    ).length;


  const markdownLinkCount =
    Array.from(
      normalized.matchAll(
        /\[[^\]]+\]\(https?:\/\/[^)\s]+\)/g,
      ),
    ).length;


  const absoluteUrlCount =
    Array.from(
      normalized.matchAll(
        /https?:\/\/[^\s)>\]]+/g,
      ),
    ).length;


  return {
    bytes:
      new TextEncoder()
        .encode(
          text,
        )
        .byteLength,

    nonEmpty:
      normalized.length >
      0,

    lineCount:
      lines.length,

    headingCount,

    h1Count,

    markdownLinkCount,

    absoluteUrlCount,

    structured:
      normalized.length >
        0 &&
      h1Count >= 1 &&
      (
        markdownLinkCount >=
          1 ||
        absoluteUrlCount >=
          1
      ),
  };
}


export function calculateLlmVisibilityScore(
  input:
    LlmVisibilityScoreInput,
) {
  let score =
    0;


  if (
    input.robotsStatusCode ===
    200
  ) {
    score +=
      10;
  }


  for (
    const crawler
    of input.searchCrawlerAccess
  ) {
    if (
      crawler
        .allRepresentativePathsAllowed
    ) {
      score +=
        15;
    } else if (
      crawler.rootAllowed
    ) {
      score +=
        8;
    }
  }


  if (
    input.llmsTxtPresent
  ) {
    score +=
      10;
  }


  if (
    input.llmsFullTxtPresent
  ) {
    score +=
      5;
  }


  if (
    input.sampledNoindex ===
    0
  ) {
    score +=
      10;
  }


  if (
    input.sampledCanonicalMismatch ===
    0
  ) {
    score +=
      10;
  }


  if (
    input.robotsSitemapCount >
    0
  ) {
    score +=
      10;
  }


  return Math.min(
    score,
    100,
  );
}


export function buildLlmsTxtPreview(
  input: {
    primaryHost: string;

    sitemapUrl: string;

    sampleUrls:
      Array<{
        url: string;
        resourceType: string;
      }>;
  },
) {
  const lines = [
    `# ${input.primaryHost}`,
    "",
    "> Candidate llms.txt preview generated read-only by Runn Search AI Indexer.",
    "",
    "## Primary resources",
    `- [Storefront](https://${input.primaryHost}/)`,
    `- [Sitemap](${input.sitemapUrl})`,
  ];


  const sample =
    input.sampleUrls.slice(
      0,
      12,
    );


  if (
    sample.length >
    0
  ) {
    lines.push(
      "",
      "## Representative content",
    );

    for (
      const entry
      of sample
    ) {
      lines.push(
        `- [${entry.resourceType}](${entry.url})`,
      );
    }
  }


  return lines.join(
    "\n",
  );
}


export function buildLlmsFullTxtPreview(
  input: {
    primaryHost: string;

    sitemapUrl: string;

    sampleUrls:
      Array<{
        url: string;
        resourceType: string;
      }>;
  },
) {
  const lines = [
    `# ${input.primaryHost} — extended candidate`,
    "",
    "> Preview only. This is not published and intentionally uses the bounded audit sample rather than the full catalog.",
    "",
    `Sitemap: ${input.sitemapUrl}`,
  ];


  if (
    input.sampleUrls.length >
    0
  ) {
    lines.push(
      "",
      "## Bounded sitemap sample",
    );

    for (
      const entry
      of input.sampleUrls
    ) {
      lines.push(
        `- ${entry.resourceType}: ${entry.url}`,
      );
    }
  }


  return lines.join(
    "\n",
  );
}