import * as cheerio from "cheerio";

export type SeoIssueSeverity =
  | "INFO"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type SeoPageType =
  | "PRODUCT"
  | "COLLECTION"
  | "PAGE"
  | "ARTICLE"
  | "HOME"
  | "UNKNOWN";

export type SeoAuditIssue = {
  code: string;
  severity: SeoIssueSeverity;
  message: string;
  details?: Record<string, unknown>;
};

export type JsonLdNode = {
  scriptIndex: number;
  path: string;
  types: string[];
  id: string | null;
  name: string | null;
  url: string | null;
  scriptId: string | null;
  scriptClass: string | null;
  sourceHint: string | null;
  raw: Record<string, unknown>;
};

export type JsonLdParseFailure = {
  scriptIndex: number;
  message: string;
};

export type SeoHtmlAuditInput = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  html: string;
  xRobotsTag?: string | null;
  redirectChain?: string[];
  expectedPageType?: SeoPageType;
};

export type SeoHtmlAuditResult = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  redirectChain: string[];

  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  h1Texts: string[];

  canonicalUrl: string | null;
  canonicalLinks: string[];

  robotsMeta: string[];
  xRobotsTag: string | null;
  noindex: boolean;

  jsonLd: {
    scriptCount: number;
    parseFailures: JsonLdParseFailure[];
    nodes: JsonLdNode[];
    typeCounts: Record<string, number>;
  };

  issues: SeoAuditIssue[];
};

const MAX_JSON_LD_NODES = 500;

const CONFLICT_FIELDS = [
  "name",
  "url",
  "sku",
  "gtin",
  "gtin8",
  "gtin12",
  "gtin13",
  "gtin14",
  "mpn",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTypes(value: unknown): string[] {
  if (typeof value === "string") {
    const type = value.trim();
    return type ? [type] : [];
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function resolvePublicUrl(
  value: unknown,
  baseUrl: string,
): string | null {
  const text = asString(value);
  if (!text) return null;

  try {
    const url = new URL(text, baseUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function getNodeUrl(
  node: Record<string, unknown>,
  baseUrl: string,
): string | null {
  const direct = resolvePublicUrl(node.url, baseUrl);
  if (direct) return direct;

  const mainEntity = node.mainEntityOfPage;

  if (typeof mainEntity === "string") {
    return resolvePublicUrl(mainEntity, baseUrl);
  }

  if (isRecord(mainEntity)) {
    return (
      resolvePublicUrl(mainEntity["@id"], baseUrl) ??
      resolvePublicUrl(mainEntity.url, baseUrl)
    );
  }

  return null;
}

function sourceHintForScript(
  scriptId: string | null,
  scriptClass: string | null,
  dataAttributes: string[],
): string | null {
  const parts = [
    scriptId,
    scriptClass,
    ...dataAttributes,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .trim();

  return parts || null;
}

function collectJsonLdNodes(input: {
  value: unknown;
  output: JsonLdNode[];
  scriptIndex: number;
  path: string;
  baseUrl: string;
  scriptId: string | null;
  scriptClass: string | null;
  sourceHint: string | null;
}) {
  if (input.output.length >= MAX_JSON_LD_NODES) return;

  if (Array.isArray(input.value)) {
    input.value.forEach((item, index) => {
      collectJsonLdNodes({
        ...input,
        value: item,
        path: `${input.path}[${index}]`,
      });
    });

    return;
  }

  if (!isRecord(input.value)) return;

  const types = normalizeTypes(input.value["@type"]);

  if (types.length > 0 || typeof input.value["@id"] === "string") {
    input.output.push({
      scriptIndex: input.scriptIndex,
      path: input.path,
      types,
      id: asString(input.value["@id"]),
      name: asString(input.value.name),
      url: getNodeUrl(input.value, input.baseUrl),
      scriptId: input.scriptId,
      scriptClass: input.scriptClass,
      sourceHint: input.sourceHint,
      raw: input.value,
    });

    if (input.output.length >= MAX_JSON_LD_NODES) return;
  }

  for (const [key, child] of Object.entries(input.value)) {
    if (key === "@context") continue;
    if (typeof child !== "object" || child === null) continue;

    collectJsonLdNodes({
      ...input,
      value: child,
      path: `${input.path}.${key}`,
    });

    if (input.output.length >= MAX_JSON_LD_NODES) return;
  }
}

function splitDirectives(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeDecimalComparable(
  value: string,
) {
  const trimmed = value.trim();

  const match =
    /^([+-]?)(\d*)(?:\.(\d*))?$/
      .exec(trimmed);

  if (
    !match ||
    (!match[2] && !match[3])
  ) {
    return trimmed;
  }

  const negative =
    match[1] === "-";

  const integer =
    (match[2] || "0")
      .replace(
        /^0+(?=\d)/,
        "",
      );

  const fraction =
    (match[3] || "")
      .replace(
        /0+$/,
        "",
      );

  const magnitude =
    fraction
      ? `${integer}.${fraction}`
      : integer;

  if (
    /^0(?:\.0*)?$/.test(
      magnitude,
    )
  ) {
    return "0";
  }

  return negative
    ? `-${magnitude}`
    : magnitude;
}

function normalizeSchemaOrgComparable(
  value: string,
) {
  const trimmed = value.trim();

  try {
    const url =
      new URL(trimmed);

    const hostname =
      url.hostname
        .toLowerCase()
        .replace(
          /^www\./,
          "",
        );

    if (
      hostname !== "schema.org" ||
      (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      )
    ) {
      return trimmed;
    }

    const pathname =
      url.pathname.replace(
        /\/+$/,
        "",
      );

    return (
      `https://schema.org${pathname}` +
      url.search +
      url.hash
    );
  } catch {
    return trimmed;
  }
}


function decodeHtmlEntityComparable(
  value: string,
) {
  const namedEntities:
    Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };

  return value.replace(
    /&(?:(amp|lt|gt|quot|apos)|#([0-9]+)|#x([0-9a-f]+));/gi,
    (
      match: string,
      named: string | undefined,
      decimal: string | undefined,
      hexadecimal: string | undefined,
    ) => {
      if (named) {
        return (
          namedEntities[
            named.toLowerCase()
          ] ?? match
        );
      }

      const codePoint =
        decimal
          ? Number.parseInt(
              decimal,
              10,
            )
          : hexadecimal
            ? Number.parseInt(
                hexadecimal,
                16,
              )
            : Number.NaN;

      if (
        !Number.isInteger(
          codePoint,
        ) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (
          codePoint >= 0xd800 &&
          codePoint <= 0xdfff
        )
      ) {
        return match;
      }

      return String.fromCodePoint(
        codePoint,
      );
    },
  );
}

function normalizeOfferComparable(
  field:
    | "price"
    | "priceCurrency"
    | "availability",
  value: string,
) {
  if (field === "price") {
    return normalizeDecimalComparable(
      value,
    );
  }

  if (field === "availability") {
    return normalizeSchemaOrgComparable(
      value,
    );
  }

  if (field === "priceCurrency") {
    return value
      .trim()
      .toUpperCase();
  }

  return value;
}

function productComparableFields(node: JsonLdNode) {
  const result: Record<string, string> = {};

  for (const field of CONFLICT_FIELDS) {
    const value = asString(node.raw[field]);

    if (value) {
      result[field] = value;
    }
  }

  const offers = node.raw.offers;
  const firstOffer = Array.isArray(offers) ? offers[0] : offers;

  if (isRecord(firstOffer)) {
    for (const field of [
      "price",
      "priceCurrency",
      "availability",
    ] as const) {
      const rawValue = firstOffer[field];

      const value =
        typeof rawValue === "number"
          ? String(rawValue)
          : asString(rawValue);

      if (value) {
        result[`offers.${field}`] =
          normalizeOfferComparable(
            field,
            value,
          );
      }
    }
  }

  return result;
}

const PRODUCT_IDENTITY_FIELDS = [
  "sku",
  "gtin",
  "gtin8",
  "gtin12",
  "gtin13",
  "gtin14",
] as const;

function normalizeIdentityValue(
  value: string,
) {
  return value
    .trim()
    .toLowerCase();
}

function sameProductEntity(
  left: JsonLdNode,
  right: JsonLdNode,
) {
  if (
    left.id &&
    right.id &&
    normalizeIdentityValue(left.id) ===
      normalizeIdentityValue(right.id)
  ) {
    return true;
  }

  if (
    !left.url ||
    !right.url ||
    normalizeIdentityValue(left.url) !==
      normalizeIdentityValue(right.url)
  ) {
    return false;
  }

  for (
    const field
    of PRODUCT_IDENTITY_FIELDS
  ) {
    const leftValue =
      asString(left.raw[field]);

    const rightValue =
      asString(right.raw[field]);

    if (
      leftValue &&
      rightValue &&
      normalizeIdentityValue(leftValue) ===
        normalizeIdentityValue(rightValue)
    ) {
      return true;
    }
  }

  return false;
}

function detectProductConflicts(
  productNodes: JsonLdNode[],
): SeoAuditIssue[] {
  if (productNodes.length < 2) {
    return [];
  }

  const conflictingPairs: Array<{
    left: {
      id: string | null;
      url: string | null;
      name: string | null;
      scriptIndex: number;
      path: string;
    };
    right: {
      id: string | null;
      url: string | null;
      name: string | null;
      scriptIndex: number;
      path: string;
    };
    conflicts: Record<
      string,
      string[]
    >;
  }> = [];

  for (
    let leftIndex = 0;
    leftIndex < productNodes.length;
    leftIndex += 1
  ) {
    for (
      let rightIndex =
        leftIndex + 1;
      rightIndex < productNodes.length;
      rightIndex += 1
    ) {
      const left =
        productNodes[leftIndex];

      const right =
        productNodes[rightIndex];

      if (
        !sameProductEntity(
          left,
          right,
        )
      ) {
        continue;
      }

      const leftFields =
        productComparableFields(left);

      const rightFields =
        productComparableFields(right);

      const fields =
        new Set([
          ...Object.keys(leftFields),
          ...Object.keys(rightFields),
        ]);

      const conflicts:
        Record<string, string[]> = {};

      for (const field of fields) {
        const leftValue =
          leftFields[field];

        const rightValue =
          rightFields[field];

        if (
          leftValue &&
          rightValue &&
          leftValue !== rightValue
        ) {
          conflicts[field] = [
            leftValue,
            rightValue,
          ];
        }
      }

      if (
        Object.keys(conflicts)
          .length === 0
      ) {
        continue;
      }

      conflictingPairs.push({
        left: {
          id: left.id,
          url: left.url,
          name: left.name,
          scriptIndex:
            left.scriptIndex,
          path:
            left.path,
        },
        right: {
          id: right.id,
          url: right.url,
          name: right.name,
          scriptIndex:
            right.scriptIndex,
          path:
            right.path,
        },
        conflicts,
      });
    }
  }

  if (
    conflictingPairs.length === 0
  ) {
    return [];
  }


  const encodingOnlyNameMismatch =
    conflictingPairs.every(
      (pair) => {
        const fields =
          Object.keys(
            pair.conflicts,
          );

        if (
          fields.length !== 1 ||
          fields[0] !== "name"
        ) {
          return false;
        }

        const values =
          pair.conflicts.name ?? [];

        if (
          values.length !== 2
        ) {
          return false;
        }

        return (
          decodeHtmlEntityComparable(
            values[0],
          ) ===
          decodeHtmlEntityComparable(
            values[1],
          )
        );
      },
    );

  if (
    encodingOnlyNameMismatch
  ) {
    return [
      {
        code:
          "PRODUCT_SCHEMA_NAME_ENCODING_MISMATCH",
        severity:
          "MEDIUM",
        message:
          "Multiple JSON-LD Product nodes expose names that differ only by HTML entity encoding.",
        details: {
          pairs:
            conflictingPairs,
        },
      },
    ];
  }

  return [
    {
      code:
        "CONFLICTING_PRODUCT_SCHEMA",
      severity:
        "HIGH",
      message:
        "Multiple JSON-LD Product nodes identified as the same entity expose conflicting values.",
      details: {
        pairs:
          conflictingPairs,
      },
    },
  ];
}
function duplicateSchemaIdentity(
  node: JsonLdNode,
  singletonType: string,
): string | null {
  if (singletonType === "Product") {
    for (
      const field
      of PRODUCT_IDENTITY_FIELDS
    ) {
      const value =
        asString(node.raw[field]);

      if (value) {
        return [
          "Product",
          `${field}:${normalizeIdentityValue(value)}`,
        ]
          .join("|")
          .toLowerCase();
      }
    }

    if (node.id) {
      return [
        "Product",
        `id:${normalizeIdentityValue(node.id)}`,
      ]
        .join("|")
        .toLowerCase();
    }
  }

  const identity = [
    singletonType,
    node.url ?? "",
    node.name ?? "",
  ]
    .join("|")
    .toLowerCase();

  if (
    identity ===
    `${singletonType.toLowerCase()}||`
  ) {
    return null;
  }

  return identity;
}
function detectDuplicateSchemaNodes(
  nodes: JsonLdNode[],
): SeoAuditIssue[] {
  const issues: SeoAuditIssue[] = [];

  const byId = new Map<string, JsonLdNode[]>();

  for (const node of nodes) {
    if (!node.id) continue;

    const existing = byId.get(node.id) ?? [];
    existing.push(node);
    byId.set(node.id, existing);
  }

  for (const [id, duplicates] of byId.entries()) {
    if (duplicates.length < 2) continue;

    issues.push({
      code: "DUPLICATE_SCHEMA_ID",
      severity: "MEDIUM",
      message: `Multiple JSON-LD nodes use the same @id: ${id}`,
      details: {
        id,
        count: duplicates.length,
        types: duplicates.map((node) => node.types),
        scripts: duplicates.map((node) => node.scriptIndex),
      },
    });
  }

  const identityMap = new Map<string, JsonLdNode[]>();

  for (const node of nodes) {
    const singletonType = node.types.find((type) =>
      [
        "Product",
        "ProductGroup",
        "Organization",
        "WebSite",
        "BreadcrumbList",
      ].includes(type),
    );

    if (!singletonType) continue;

    const identity =
      duplicateSchemaIdentity(
        node,
        singletonType,
      );

    if (!identity) {
      continue;
    }

    const existing = identityMap.get(identity) ?? [];
    existing.push(node);
    identityMap.set(identity, existing);
  }

  for (const [identity, duplicates] of identityMap.entries()) {
    if (duplicates.length < 2) continue;

    issues.push({
      code: "POTENTIAL_DUPLICATE_SCHEMA_NODE",
      severity: "MEDIUM",
      message:
        "Potential duplicate structured-data nodes describe the same entity.",
      details: {
        identity,
        count: duplicates.length,
        scripts: duplicates.map((node) => node.scriptIndex),
        sourceHints: duplicates.map((node) => node.sourceHint),
      },
    });
  }

  return issues;
}

function severityForHttp(
  statusCode: number,
): SeoIssueSeverity | null {
  if (statusCode >= 500) return "CRITICAL";
  if (statusCode >= 400) return "HIGH";
  if (statusCode >= 300) return "MEDIUM";

  return null;
}

export function auditHtml(
  input: SeoHtmlAuditInput,
): SeoHtmlAuditResult {
  const $ = cheerio.load(input.html);

  const issues: SeoAuditIssue[] = [];

  const title = $("title").first().text().trim() || null;

  const metaDescription =
    $('meta[name="description"]')
      .first()
      .attr("content")
      ?.trim() || null;

  const h1Texts = $("h1")
    .toArray()
    .map((element) => $(element).text().trim())
    .filter(Boolean);

  const canonicalLinks = $('link[rel~="canonical"]')
    .toArray()
    .map((element) => $(element).attr("href"))
    .filter((value): value is string => Boolean(value))
    .map((value) => resolvePublicUrl(value, input.finalUrl))
    .filter((value): value is string => Boolean(value));

  const canonicalUrl =
    canonicalLinks.length === 1
      ? canonicalLinks[0]
      : null;

  const robotsMeta = $('meta[name="robots"]')
    .toArray()
    .map((element) => $(element).attr("content")?.trim())
    .filter((value): value is string => Boolean(value));

  const robotDirectives = splitDirectives([
    ...robotsMeta,
    ...(input.xRobotsTag ? [input.xRobotsTag] : []),
  ]);

  const noindex = robotDirectives.some(
    (directive) =>
      directive === "noindex" ||
      directive.endsWith(": noindex"),
  );

  const httpSeverity = severityForHttp(input.statusCode);

  if (httpSeverity) {
    issues.push({
      code: `HTTP_${input.statusCode}`,
      severity: httpSeverity,
      message: `Page returned HTTP ${input.statusCode}.`,
    });
  }

  if ((input.redirectChain?.length ?? 0) > 0) {
    issues.push({
      code: "HTTP_REDIRECT",
      severity: "INFO",
      message: "Requested URL required one or more redirects.",
      details: {
        redirectChain: input.redirectChain ?? [],
      },
    });
  }

  if (!title) {
    issues.push({
      code: "TITLE_MISSING",
      severity: "MEDIUM",
      message: "Page has no non-empty HTML title.",
    });
  }

  if (!metaDescription) {
    issues.push({
      code: "META_DESCRIPTION_MISSING",
      severity: "LOW",
      message: "Page has no non-empty meta description.",
    });
  }

  if (h1Texts.length === 0) {
    issues.push({
      code: "H1_MISSING",
      severity: "MEDIUM",
      message: "Page has no non-empty H1.",
    });
  } else if (h1Texts.length > 1) {
    issues.push({
      code: "H1_MULTIPLE",
      severity: "LOW",
      message: "Page contains multiple H1 elements.",
      details: {
        count: h1Texts.length,
      },
    });
  }

  if (canonicalLinks.length === 0) {
    issues.push({
      code: "CANONICAL_MISSING",
      severity: "MEDIUM",
      message: "Page has no canonical link.",
    });
  } else if (canonicalLinks.length > 1) {
    issues.push({
      code: "CANONICAL_MULTIPLE",
      severity: "HIGH",
      message: "Page exposes multiple canonical links.",
      details: {
        canonicalLinks,
      },
    });
  }

  if (noindex) {
    issues.push({
      code: "NOINDEX_PRESENT",
      severity: "HIGH",
      message: "Page contains a noindex directive.",
      details: {
        robotsMeta,
        xRobotsTag: input.xRobotsTag ?? null,
      },
    });
  }

  const nodes: JsonLdNode[] = [];
  const parseFailures: JsonLdParseFailure[] = [];

  const scripts = $('script[type="application/ld+json"]').toArray();

  scripts.forEach((element, scriptIndex) => {
    const script = $(element);
    const rawText = script.html()?.trim() ?? "";

    if (!rawText) return;

    const scriptId =
      script.attr("id")?.trim() || null;

    const scriptClass =
      script.attr("class")?.trim() || null;

    const attributes = script.attr() ?? {};

    const dataAttributes = Object.entries(attributes)
      .filter(
        ([key, value]) =>
          key.startsWith("data-") && Boolean(value),
      )
      .map(([key, value]) => `${key}=${value}`);

    const sourceHint = sourceHintForScript(
      scriptId,
      scriptClass,
      dataAttributes,
    );

    try {
      const parsed: unknown = JSON.parse(rawText);

      collectJsonLdNodes({
        value: parsed,
        output: nodes,
        scriptIndex,
        path: "$",
        baseUrl: input.finalUrl,
        scriptId,
        scriptClass,
        sourceHint,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown JSON parse error";

      parseFailures.push({
        scriptIndex,
        message,
      });

      issues.push({
        code: "JSON_LD_PARSE_ERROR",
        severity: "HIGH",
        message:
          "A JSON-LD script could not be parsed.",
        details: {
          scriptIndex,
          message,
          sourceHint,
        },
      });
    }
  });

  if (nodes.length >= MAX_JSON_LD_NODES) {
    issues.push({
      code: "JSON_LD_NODE_LIMIT_REACHED",
      severity: "MEDIUM",
      message:
        "Structured-data node safety limit was reached; result may be incomplete.",
      details: {
        limit: MAX_JSON_LD_NODES,
      },
    });
  }

  const typeCounts: Record<string, number> = {};

  for (const node of nodes) {
    for (const type of node.types) {
      typeCounts[type] =
        (typeCounts[type] ?? 0) + 1;
    }
  }

  issues.push(...detectDuplicateSchemaNodes(nodes));

  const productNodes = nodes.filter((node) =>
    node.types.includes("Product"),
  );

  issues.push(...detectProductConflicts(productNodes));

  if (
    input.expectedPageType === "PRODUCT" &&
    productNodes.length === 0
  ) {
    issues.push({
      code: "PRODUCT_SCHEMA_MISSING",
      severity: "HIGH",
      message:
        "Expected product page does not expose a Product JSON-LD node.",
    });
  }

  if (
    input.expectedPageType === "PRODUCT" &&
    (typeCounts.BreadcrumbList ?? 0) === 0
  ) {
    issues.push({
      code: "BREADCRUMB_SCHEMA_MISSING",
      severity: "LOW",
      message:
        "Product page does not expose BreadcrumbList structured data.",
    });
  }

  return {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    statusCode: input.statusCode,
    redirectChain: input.redirectChain ?? [],

    title,
    metaDescription,
    h1Count: h1Texts.length,
    h1Texts,

    canonicalUrl,
    canonicalLinks,

    robotsMeta,
    xRobotsTag: input.xRobotsTag ?? null,
    noindex,

    jsonLd: {
      scriptCount: scripts.length,
      parseFailures,
      nodes,
      typeCounts,
    },

    issues,
  };
}