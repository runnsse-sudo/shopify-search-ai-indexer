import * as cheerio from "cheerio";
import {
  auditHtml,
  type JsonLdNode,
  type SeoHtmlAuditInput,
} from "./html-audit";

export const RETIREMENT_TYPES = [
  "Product",
  "ProductGroup",
  "Offer",
  "AggregateOffer",
  "BreadcrumbList",
  "Organization",
  "OnlineStore",
  "WebSite",
  "MerchantReturnPolicy",
  "ShippingService",
  "OfferShippingDetails",
] as const;
export type SchemaOwner = "AUTO_SCHEMA" | "RUNN" | "OTHER_PERSISTENT";
export type RetirementPage = SeoHtmlAuditInput & {
  expectedCurrency?: string;
  requiredTypes?: string[];
};
export type RetirementFinding = { code: string; url: string; details: unknown };

function owner(
  node: JsonLdNode & { certificationOwner?: SchemaOwner },
): SchemaOwner {
  return node.certificationOwner ?? "OTHER_PERSISTENT";
}
function ownedAudit(page: SeoHtmlAuditInput) {
  const $ = cheerio.load(page.html);
  const owners = $('script[type="application/ld+json"]')
    .toArray()
    .map((element): SchemaOwner => {
      const marker = ($(element).attr("data-added-by") ?? "")
        .trim()
        .toLowerCase();
      if (marker === "autoschema") return "AUTO_SCHEMA";
      if (marker === "runn-schema-storefront") return "RUNN";
      return "OTHER_PERSISTENT";
    });
  const audit = auditHtml(page);
  return {
    ...audit,
    jsonLd: {
      ...audit.jsonLd,
      nodes: audit.jsonLd.nodes.map((node) => ({
        ...node,
        certificationOwner: owners[node.scriptIndex] ?? "OTHER_PERSISTENT",
      })),
    },
  };
}
function fullNodes(nodes: JsonLdNode[]) {
  return nodes.filter(
    (node) =>
      node.types.length > 0 &&
      Object.keys(node.raw).some(
        (key) => !["@id", "@type", "@context"].includes(key),
      ),
  );
}
function definitionCounts(nodes: JsonLdNode[]) {
  const counts: Record<string, number> = {};
  for (const node of fullNodes(nodes))
    for (const type of node.types) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}
function auditDefinitions(page: SeoHtmlAuditInput) {
  const $ = cheerio.load(page.html);
  const withoutReferenceTypes = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutReferenceTypes);
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value);
    const reference = entries.every(([key]) =>
      ["@id", "@type", "@context"].includes(key),
    );
    return Object.fromEntries(
      entries
        .filter(([key]) => !(reference && key === "@type"))
        .map(([key, child]) => [key, withoutReferenceTypes(child)]),
    );
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      $(element).text(
        JSON.stringify(
          withoutReferenceTypes(JSON.parse($(element).html() ?? "")),
        ).replace(/</g, "\\u003c"),
      );
    } catch {
      // Preserve malformed scripts; the original audit reports their parse failures.
    }
  });
  return auditHtml({ ...page, html: $.html() });
}
function absoluteId(node: JsonLdNode, url: string) {
  if (!node.id) return null;
  try {
    return new URL(node.id, url).href;
  } catch {
    return node.id;
  }
}
function duplicateDefinitions(nodes: JsonLdNode[], url: string) {
  const ids = new Map<string, JsonLdNode[]>();
  for (const node of fullNodes(nodes)) {
    const id = absoluteId(node, url);
    if (id) ids.set(id, [...(ids.get(id) ?? []), node]);
  }
  return [...ids]
    .filter(([, group]) => group.length > 1)
    .map(([id, group]) => ({
      id,
      owners: group.map(owner),
      scripts: group.map((node) => node.scriptIndex),
    }));
}
function required(page: RetirementPage, observed: Record<string, number>) {
  const types = new Set(page.requiredTypes ?? []);
  if (page.expectedPageType === "PRODUCT") {
    types.add("Product");
    types.add(
      observed.AggregateOffer && !observed.Offer ? "AggregateOffer" : "Offer",
    );
    types.add("BreadcrumbList");
  }
  if (
    page.expectedPageType === "COLLECTION" ||
    page.expectedPageType === "PAGE"
  )
    types.add("BreadcrumbList");
  if (page.expectedPageType === "HOME") {
    types.add("WebSite");
    types.add("OnlineStore");
    types.add("Organization");
  }
  for (const type of RETIREMENT_TYPES) if (observed[type]) types.add(type);
  return [...types];
}

export function certifySchemaRetirement(pages: RetirementPage[]) {
  const findings: RetirementFinding[] = [];
  if (!pages.length)
    findings.push({ code: "EMPTY_CERTIFICATION", url: "", details: null });
  const reports = pages.map((page) => {
    const before = ownedAudit(page);
    const $ = cheerio.load(page.html);
    $('script[type="application/ld+json"]').each((_, element) => {
      if (
        ($(element).attr("data-added-by") ?? "").trim().toLowerCase() ===
        "autoschema"
      )
        $(element).remove();
    });
    const after = ownedAudit({ ...page, html: $.html() });
    const surviving = definitionCounts(after.jsonLd.nodes);
    const add = (code: string, details: unknown) =>
      findings.push({ code, url: page.requestedUrl, details });
    if (page.statusCode !== 200) add("HTTP_NOT_200", page.statusCode);
    if (!before.jsonLd.scriptCount) add("NO_JSON_LD", null);
    if (before.jsonLd.parseFailures.length)
      add("JSON_LD_PARSE_FAILURE", before.jsonLd.parseFailures);
    if (after.jsonLd.parseFailures.length)
      add("PERSISTENT_JSON_LD_PARSE_FAILURE", after.jsonLd.parseFailures);
    if (
      before.issues.some((issue) => issue.code === "JSON_LD_NODE_LIMIT_REACHED")
    )
      add("INCOMPLETE_NODE_INVENTORY", null);
    const matrix = RETIREMENT_TYPES.map((type) => {
      const counts = { AUTO_SCHEMA: 0, RUNN: 0, OTHER_PERSISTENT: 0 };
      for (const node of fullNodes(before.jsonLd.nodes))
        if (node.types.includes(type)) counts[owner(node)]++;
      return { type, ...counts, surviving: surviving[type] ?? 0 };
    });
    for (const type of required(page, before.jsonLd.typeCounts)) {
      const compatible =
        type === "Organization"
          ? (surviving.Organization ?? 0) + (surviving.OnlineStore ?? 0)
          : surviving[type];
      if (!compatible) add("SCHEMA_DEPENDENCY_OR_MISSING", { type });
    }
    const duplicatesBefore = duplicateDefinitions(
      before.jsonLd.nodes,
      page.finalUrl,
    );
    const duplicatesAfter = duplicateDefinitions(
      after.jsonLd.nodes,
      page.finalUrl,
    );
    if (duplicatesAfter.length) add("PERSISTENT_DUPLICATE_ID", duplicatesAfter);
    const storesByUrl = new Map<string, JsonLdNode[]>();
    for (const node of fullNodes(after.jsonLd.nodes)) {
      if (node.types.includes("OnlineStore") && node.url)
        storesByUrl.set(node.url, [...(storesByUrl.get(node.url) ?? []), node]);
    }
    for (const [url, stores] of storesByUrl) {
      if (stores.length > 1)
        add("PERSISTENT_DUPLICATE_ONLINE_STORE", {
          url,
          ids: stores.map((node) => node.id),
        });
    }
    const schemaIssues = auditDefinitions({
      ...page,
      html: $.html(),
    }).issues.filter((issue) =>
      [
        "CONFLICTING_PRODUCT_SCHEMA",
        "POTENTIAL_DUPLICATE_SCHEMA_NODE",
        "PRODUCT_SCHEMA_NAME_ENCODING_MISMATCH",
      ].includes(issue.code),
    );
    for (const issue of schemaIssues)
      add("PERSISTENT_" + issue.code, issue.details);
    const writerScripts = new Set(
      fullNodes(after.jsonLd.nodes)
        .filter(
          (node) =>
            node.types.includes("Product") ||
            node.types.includes("ProductGroup"),
        )
        .map((node) => node.scriptIndex),
    );
    if (writerScripts.size > 1)
      add("COMPETING_PERSISTENT_PRODUCT_WRITERS", [...writerScripts]);
    const currencies = fullNodes(before.jsonLd.nodes).filter(
      (node) =>
        node.types.includes("Offer") || node.types.includes("AggregateOffer"),
    );
    const currencyPairs = [];
    for (let i = 0; i < currencies.length; i++)
      for (let j = i + 1; j < currencies.length; j++) {
        const a = currencies[i],
          b = currencies[j];
        const idA = absoluteId(a, page.finalUrl),
          idB = absoluteId(b, page.finalUrl);
        const same = (idA && idA === idB) || (a.url && a.url === b.url);
        if (
          same &&
          a.raw.priceCurrency &&
          b.raw.priceCurrency &&
          String(a.raw.priceCurrency).toUpperCase() !==
            String(b.raw.priceCurrency).toUpperCase()
        ) {
          currencyPairs.push({
            owners: [owner(a), owner(b)],
            currencies: [a.raw.priceCurrency, b.raw.priceCurrency],
            id: idA,
          });
        }
      }
    if (currencyPairs.length) add("LOCALIZED_CURRENCY_MISMATCH", currencyPairs);
    if (page.expectedCurrency)
      for (const offer of currencies) {
        if (
          String(offer.raw.priceCurrency ?? "").toUpperCase() !==
          page.expectedCurrency.toUpperCase()
        )
          add("EXPECTED_CURRENCY_MISMATCH", {
            owner: owner(offer),
            expected: page.expectedCurrency,
            actual: offer.raw.priceCurrency,
          });
      }
    return {
      url: page.requestedUrl,
      matrix,
      duplicatesBefore,
      duplicatesAfter,
      issuesBefore: before.issues.filter((issue) =>
        /SCHEMA|JSON_LD/.test(issue.code),
      ),
      issuesAfter: after.issues.filter((issue) =>
        /SCHEMA|JSON_LD/.test(issue.code),
      ),
      nodes: fullNodes(before.jsonLd.nodes).map((node) => ({
        ...node,
        certificationOwner: owner(node),
      })),
    };
  });
  const policies = reports.flatMap((report) =>
    report.nodes
      .filter((node) => node.types.includes("MerchantReturnPolicy"))
      .map((node) => ({ url: report.url, node })),
  );
  const returnMismatches = [];
  for (let i = 0; i < policies.length; i++)
    for (let j = i + 1; j < policies.length; j++) {
      const a = policies[i],
        b = policies[j];
      const countries = (value: unknown) =>
        (Array.isArray(value) ? value : [value])
          .filter((country): country is string => typeof country === "string")
          .map((country) => country.toUpperCase());
      const countryA = countries(a.node.raw.applicableCountry),
        countryB = countries(b.node.raw.applicableCountry);
      const daysA = a.node.raw.merchantReturnDays,
        daysB = b.node.raw.merchantReturnDays;
      if (
        countryA.some((country) => countryB.includes(country)) &&
        daysA != null &&
        daysB != null &&
        Number.isFinite(Number(daysA)) &&
        Number.isFinite(Number(daysB)) &&
        Number(daysA) !== Number(daysB)
      ) {
        returnMismatches.push({
          country: countryA.filter((country) => countryB.includes(country)),
          urls: [a.url, b.url],
          owners: [a.node.certificationOwner, b.node.certificationOwner],
          days: [daysA, daysB],
        });
      }
    }
  if (returnMismatches.length)
    findings.push({
      code: "RETURN_WINDOW_MISMATCH_REQUIRES_VERIFICATION",
      url: "",
      details: returnMismatches,
    });
  return {
    decision: findings.length ? "BLOCKED" : "SAMPLE_PARITY_PASSED",
    automaticDisableAuthorized: false,
    scope:
      "Captured server HTML only; sample coverage, ownership, rendered-browser behavior and business facts require separate rollout approval.",
    findings,
    pages: reports,
  };
}
