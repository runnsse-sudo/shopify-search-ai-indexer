import assert from "node:assert/strict";
import {
  auditHtml,
} from "../build-tests/seo-html-audit.mjs";

const healthyHtml = `
<!doctype html>
<html>
<head>
  <title>Example Product</title>
  <meta
    name="description"
    content="A useful product description"
  >
  <link
    rel="canonical"
    href="https://example.com/products/example-product"
  >
</head>
<body>

  <h1>Example Product</h1>

  <script
    type="application/ld+json"
    id="theme-product-schema"
  >
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        "@id": "https://example.com/products/example-product#product",
        "name": "Example Product",
        "url": "https://example.com/products/example-product",
        "sku": "ABC-123",
        "offers": {
          "@type": "Offer",
          "price": "199.00",
          "priceCurrency": "SEK",
          "availability": "https://schema.org/InStock"
        }
      },
      {
        "@type": "BreadcrumbList",
        "@id": "https://example.com/products/example-product#breadcrumb",
        "itemListElement": []
      },
      {
        "@type": "Organization",
        "@id": "https://example.com/#organization",
        "name": "Example Shop",
        "url": "https://example.com/"
      }
    ]
  }
  </script>

</body>
</html>
`;

const healthy = auditHtml({
  requestedUrl:
    "https://example.com/products/example-product",

  finalUrl:
    "https://example.com/products/example-product",

  statusCode: 200,

  html: healthyHtml,

  expectedPageType: "PRODUCT",
});

assert.equal(
  healthy.title,
  "Example Product",
);

assert.equal(
  healthy.h1Count,
  1,
);

assert.equal(
  healthy.canonicalUrl,
  "https://example.com/products/example-product",
);

assert.equal(
  healthy.noindex,
  false,
);

assert.equal(
  healthy.jsonLd.typeCounts.Product,
  1,
);

assert.equal(
  healthy.jsonLd.typeCounts.Offer,
  1,
);

assert.equal(
  healthy.jsonLd.typeCounts.BreadcrumbList,
  1,
);

assert.equal(
  healthy.jsonLd.typeCounts.Organization,
  1,
);

assert.equal(
  healthy.jsonLd.parseFailures.length,
  0,
);

assert.equal(
  healthy.issues.some(
    (issue) =>
      issue.severity === "CRITICAL",
  ),
  false,
);

const productGroupHtml = `
<!doctype html>
<html>
<head>
  <title>Grouped Product</title>
  <meta
    name="description"
    content="Grouped product test"
  >
  <link
    rel="canonical"
    href="https://example.com/products/grouped-product"
  >
</head>
<body>
  <h1>Grouped Product</h1>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ProductGroup",
    "@id": "https://example.com/products/grouped-product#group",
    "name": "Grouped Product",
    "url": "https://example.com/products/grouped-product",
    "hasVariant": [
      {
        "@type": "Product",
        "@id": "https://example.com/products/grouped-product#variant-red",
        "name": "Grouped Product",
        "url": "https://example.com/products/grouped-product",
        "sku": "GROUP-RED",
        "mpn": "GROUP-MODEL",
        "offers": {
          "@type": "Offer",
          "price": "199.00",
          "priceCurrency": "SEK"
        }
      },
      {
        "@type": "Product",
        "@id": "https://example.com/products/grouped-product#variant-blue",
        "name": "Grouped Product",
        "url": "https://example.com/products/grouped-product",
        "sku": "GROUP-BLUE",
        "mpn": "GROUP-MODEL",
        "offers": {
          "@type": "Offer",
          "price": "249.00",
          "priceCurrency": "SEK"
        }
      }
    ]
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": "https://example.com/products/grouped-product#breadcrumb",
    "itemListElement": []
  }
  </script>
</body>
</html>
`;

const productGroup =
  auditHtml({
    requestedUrl:
      "https://example.com/products/grouped-product",

    finalUrl:
      "https://example.com/products/grouped-product",

    statusCode: 200,

    html:
      productGroupHtml,

    expectedPageType:
      "PRODUCT",
  });

const productGroupCodes =
  new Set(
    productGroup.issues.map(
      (issue) => issue.code,
    ),
  );

assert.equal(
  productGroup.jsonLd
    .typeCounts.ProductGroup,
  1,
);

assert.equal(
  productGroup.jsonLd
    .typeCounts.Product,
  2,
);

assert.equal(
  productGroupCodes.has(
    "CONFLICTING_PRODUCT_SCHEMA",
  ),
  false,
  "Legitimate ProductGroup variants must not be treated as conflicting duplicate Product schema.",
);

assert.equal(
  productGroupCodes.has(
    "POTENTIAL_DUPLICATE_SCHEMA_NODE",
  ),
  false,
  "Legitimate ProductGroup variants must not be treated as duplicate Product schema nodes.",
);
const equivalentProductSerializationHtml = `
<!doctype html>
<html>
<head>
  <title>Equivalent Product</title>
  <meta
    name="description"
    content="Equivalent schema serialization test"
  >
  <link
    rel="canonical"
    href="https://example.com/products/equivalent-product"
  >
</head>
<body>
  <h1>Equivalent Product</h1>

  <script
    type="application/ld+json"
    data-added-by="autoSchema"
  >
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "https://example.com/products/equivalent-product#product",
    "name": "Equivalent Product",
    "url": "https://example.com/products/equivalent-product",
    "sku": "EQ-619",
    "offers": {
      "@type": "Offer",
      "price": "619",
      "priceCurrency": "SEK",
      "availability": "https://schema.org/InStock"
    }
  }
  </script>

  <script
    type="application/ld+json"
  >
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "/products/equivalent-product#product",
    "name": "Equivalent Product",
    "url": "https://example.com/products/equivalent-product",
    "sku": "EQ-619",
    "offers": {
      "@type": "Offer",
      "price": "619.00",
      "priceCurrency": "sek",
      "availability": "http://schema.org/InStock"
    }
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": []
  }
  </script>
</body>
</html>
`;

const equivalentProductSerialization =
  auditHtml({
    requestedUrl:
      "https://example.com/products/equivalent-product",

    finalUrl:
      "https://example.com/products/equivalent-product",

    statusCode:
      200,

    html:
      equivalentProductSerializationHtml,

    expectedPageType:
      "PRODUCT",
  });

const equivalentProductSerializationCodes =
  new Set(
    equivalentProductSerialization
      .issues
      .map(
        (issue) =>
          issue.code,
      ),
  );

assert.equal(
  equivalentProductSerializationCodes.has(
    "CONFLICTING_PRODUCT_SCHEMA",
  ),
  false,
  "Equivalent numeric price formatting and http/https Schema.org availability terms must not be treated as conflicting Product schema.",
);


const htmlEntityNameMismatchHtml = `
<!doctype html>
<html>
<head>
  <title>Ampersand Product</title>
  <meta
    name="description"
    content="HTML entity Product name comparison test"
  >
  <link
    rel="canonical"
    href="https://example.com/products/ampersand-product"
  >
</head>
<body>
  <h1>Ampersand Product</h1>

  <script
    type="application/ld+json"
    data-added-by="source-a"
  >
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "https://example.com/products/ampersand-product#product-a",
    "name": "Ampersand &amp; Product",
    "url": "https://example.com/products/ampersand-product",
    "sku": "AMP-SOURCE-A",
    "gtin13": "1234567890123",
    "offers": {
      "@type": "Offer",
      "price": "299.00",
      "priceCurrency": "SEK",
      "availability": "https://schema.org/InStock"
    }
  }
  </script>

  <script
    type="application/ld+json"
    data-added-by="source-b"
  >
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "/products/ampersand-product#product-b",
    "name": "Ampersand & Product",
    "url": "https://example.com/products/ampersand-product",
    "gtin13": "1234567890123",
    "offers": {
      "@type": "Offer",
      "price": "299",
      "priceCurrency": "sek",
      "availability": "http://schema.org/InStock"
    }
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": []
  }
  </script>
</body>
</html>
`;

const htmlEntityNameMismatch =
  auditHtml({
    requestedUrl:
      "https://example.com/products/ampersand-product",

    finalUrl:
      "https://example.com/products/ampersand-product",

    statusCode:
      200,

    html:
      htmlEntityNameMismatchHtml,

    expectedPageType:
      "PRODUCT",
  });

const htmlEntityHighConflict =
  htmlEntityNameMismatch
    .issues
    .find(
      (issue) =>
        issue.code ===
        "CONFLICTING_PRODUCT_SCHEMA",
    );

const htmlEntityEncodingIssue =
  htmlEntityNameMismatch
    .issues
    .find(
      (issue) =>
        issue.code ===
        "PRODUCT_SCHEMA_NAME_ENCODING_MISMATCH",
    );

assert.equal(
  htmlEntityHighConflict,
  undefined,
  "Names differing only by HTML entity encoding must not become a HIGH Product conflict.",
);

assert.ok(
  htmlEntityEncodingIssue,
  "Expected Product name encoding mismatch issue.",
);

assert.equal(
  htmlEntityEncodingIssue.severity,
  "MEDIUM",
  "Entity-only Product name mismatch must be MEDIUM.",
);


/*
 * Separate guard:
 * a REAL name-only difference must still remain HIGH.
 */

/*
 * Regression guard:
 * Double-encoded HTML entities must normalize to the same
 * visible Product name and must not become a HIGH conflict.
 *
 * Real-world reproduction:
 *   7&amp;quot;
 * versus
 *   7&quot;
 */
const doubleEncodedNameMismatchHtml = `
<!doctype html>
<html>
<head>
  <title>Double Encoded Product</title>
  <meta
    name="description"
    content="Double encoded HTML entity Product name comparison test"
  >
  <link
    rel="canonical"
    href="https://example.com/products/double-encoded-product"
  >
</head>
<body>
  <h1>Double Encoded Product</h1>

  <script
    type="application/ld+json"
    data-added-by="source-a"
  >
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "https://example.com/products/double-encoded-product#product",
    "name": "TMNT – 7&amp;quot; Actionfigur – Ultimate Leonardo (VHS)",
    "url": "https://example.com/products/double-encoded-product",
    "gtin": "634482543528",
    "mpn": "BFI-634482543528-NECA54352",
    "offers": {
      "@type": "Offer",
      "price": "609",
      "priceCurrency": "SEK",
      "availability": "https://schema.org/InStock"
    }
  }
  </script>

  <script
    type="application/ld+json"
    data-added-by="source-b"
  >
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "/products/double-encoded-product#product",
    "name": "TMNT – 7&quot; Actionfigur – Ultimate Leonardo (VHS)",
    "url": "https://example.com/products/double-encoded-product",
    "sku": "BFI-634482543528-NECA54352",
    "gtin": "634482543528",
    "offers": {
      "@type": "Offer",
      "price": "609.00",
      "priceCurrency": "SEK",
      "availability": "http://schema.org/InStock"
    }
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": []
  }
  </script>
</body>
</html>
`;

const doubleEncodedNameMismatch =
  auditHtml({
    requestedUrl:
      "https://example.com/products/double-encoded-product",

    finalUrl:
      "https://example.com/products/double-encoded-product",

    statusCode:
      200,

    html:
      doubleEncodedNameMismatchHtml,

    expectedPageType:
      "PRODUCT",
  });

const doubleEncodedHighConflict =
  doubleEncodedNameMismatch
    .issues
    .find(
      (issue) =>
        issue.code ===
        "CONFLICTING_PRODUCT_SCHEMA",
    );

const doubleEncodedEncodingIssue =
  doubleEncodedNameMismatch
    .issues
    .find(
      (issue) =>
        issue.code ===
        "PRODUCT_SCHEMA_NAME_ENCODING_MISMATCH",
    );

assert.equal(
  doubleEncodedHighConflict,
  undefined,
  "Double-encoded HTML entities must not become a HIGH Product conflict.",
);

assert.ok(
  doubleEncodedEncodingIssue,
  "Expected double-encoded Product name mismatch to be classified as an encoding issue.",
);

assert.equal(
  doubleEncodedEncodingIssue.severity,
  "MEDIUM",
  "Double-encoded Product name mismatch must be MEDIUM.",
);

const semanticNameConflictHtml = `
<!doctype html>
<html>
<head>
  <title>Semantic Name Conflict</title>
  <meta
    name="description"
    content="Real Product name conflict test"
  >
  <link
    rel="canonical"
    href="https://example.com/products/name-conflict"
  >
</head>
<body>
  <h1>Semantic Name Conflict</h1>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "https://example.com/products/name-conflict#product-a",
    "name": "Original Product Name",
    "url": "https://example.com/products/name-conflict",
    "sku": "NAME-SOURCE-A",
    "gtin13": "1234567890124",
    "offers": {
      "@type": "Offer",
      "price": "399.00",
      "priceCurrency": "SEK",
      "availability": "https://schema.org/InStock"
    }
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "/products/name-conflict#product-b",
    "name": "Actually Different Product Name",
    "url": "https://example.com/products/name-conflict",
    "gtin13": "1234567890124",
    "offers": {
      "@type": "Offer",
      "price": "399",
      "priceCurrency": "sek",
      "availability": "http://schema.org/InStock"
    }
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": []
  }
  </script>
</body>
</html>
`;

const semanticNameConflict =
  auditHtml({
    requestedUrl:
      "https://example.com/products/name-conflict",

    finalUrl:
      "https://example.com/products/name-conflict",

    statusCode:
      200,

    html:
      semanticNameConflictHtml,

    expectedPageType:
      "PRODUCT",
  });

const semanticNameHigh =
  semanticNameConflict
    .issues
    .find(
      (issue) =>
        issue.code ===
        "CONFLICTING_PRODUCT_SCHEMA",
    );

assert.ok(
  semanticNameHigh,
  "A genuinely different Product name must remain a conflict.",
);

assert.equal(
  semanticNameHigh.severity,
  "HIGH",
  "A genuine Product name conflict must remain HIGH.",
);

/*
 * Structured-data provenance foundation.
 *
 * Missing source hints are intentionally classified as
 * STOREFRONT rather than SHOPIFY until explicit ownership
 * evidence exists.
 */
const provenanceHtml = `
<!doctype html>
<html>
<head>
  <title>Provenance Product</title>
  <meta
    name="description"
    content="Structured data provenance verification"
  >
  <link
    rel="canonical"
    href="https://example.com/products/provenance-product"
  >
</head>
<body>
  <h1>Provenance Product</h1>

  <script
    type="application/ld+json"
    data-added-by="autoSchema"
  >
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "autoSchema page"
  }
  </script>

  <script
    type="application/ld+json"
    class="jdgm-server-jld"
  >
  {
    "@context": "https://schema.org",
    "@type": "AggregateRating",
    "ratingValue": "5"
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "https://example.com/products/provenance-product#product",
    "name": "Provenance Product",
    "url": "https://example.com/products/provenance-product",
    "sku": "PROVENANCE-1"
  }
  </script>

  <script
    type="application/ld+json"
    data-provider="mystery-schema"
  >
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "Mystery provider"
  }
  </script>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": []
  }
  </script>

  <script
    type="application/ld+json"
    data-added-by="autoSchema"
  >
    { this is invalid json }
  </script>
</body>
</html>
`;

const provenance =
  auditHtml({
    requestedUrl:
      "https://example.com/products/provenance-product",

    finalUrl:
      "https://example.com/products/provenance-product",

    statusCode:
      200,

    html:
      provenanceHtml,

    expectedPageType:
      "PRODUCT",
  });

const autoSchemaNode =
  provenance.jsonLd.nodes.find(
    (node) =>
      node.types.includes(
        "WebPage",
      ),
  );

assert.ok(
  autoSchemaNode,
  "Expected autoSchema WebPage node.",
);

assert.deepEqual(
  {
    owner:
      autoSchemaNode.provenanceOwner,
    provider:
      autoSchemaNode.provenanceProvider,
    confidence:
      autoSchemaNode.provenanceConfidence,
  },
  {
    owner:
      "EXTERNAL_INTEGRATION",
    provider:
      "autoSchema",
    confidence:
      "HIGH",
  },
);

const judgeMeNode =
  provenance.jsonLd.nodes.find(
    (node) =>
      node.types.includes(
        "AggregateRating",
      ),
  );

assert.ok(
  judgeMeNode,
  "Expected Judge.me AggregateRating node.",
);

assert.deepEqual(
  {
    owner:
      judgeMeNode.provenanceOwner,
    provider:
      judgeMeNode.provenanceProvider,
    confidence:
      judgeMeNode.provenanceConfidence,
  },
  {
    owner:
      "EXTERNAL_INTEGRATION",
    provider:
      "jdgm-server-jld",
    confidence:
      "HIGH",
  },
);

const storefrontNode =
  provenance.jsonLd.nodes.find(
    (node) =>
      node.types.includes(
        "Product",
      ),
  );

assert.ok(
  storefrontNode,
  "Expected unattributed storefront Product node.",
);

assert.deepEqual(
  {
    owner:
      storefrontNode.provenanceOwner,
    provider:
      storefrontNode.provenanceProvider,
    confidence:
      storefrontNode.provenanceConfidence,
  },
  {
    owner:
      "STOREFRONT",
    provider:
      null,
    confidence:
      "MEDIUM",
  },
);

const detectedNode =
  provenance.jsonLd.nodes.find(
    (node) =>
      node.types.includes(
        "WebSite",
      ),
  );

assert.ok(
  detectedNode,
  "Expected explicitly hinted unknown schema node.",
);

assert.equal(
  detectedNode.sourceHint,
  "data-provider=mystery-schema",
);

assert.deepEqual(
  {
    owner:
      detectedNode.provenanceOwner,
    provider:
      detectedNode.provenanceProvider,
    confidence:
      detectedNode.provenanceConfidence,
  },
  {
    owner:
      "DETECTED",
    provider:
      null,
    confidence:
      "LOW",
  },
);

const autoSchemaParseFailure =
  provenance.jsonLd
    .parseFailures
    .find(
      (failure) =>
        failure.sourceHint ===
        "data-added-by=autoSchema",
    );

assert.ok(
  autoSchemaParseFailure,
  "Expected autoSchema parse failure provenance.",
);

assert.deepEqual(
  {
    owner:
      autoSchemaParseFailure
        .provenanceOwner,
    provider:
      autoSchemaParseFailure
        .provenanceProvider,
    confidence:
      autoSchemaParseFailure
        .provenanceConfidence,
  },
  {
    owner:
      "EXTERNAL_INTEGRATION",
    provider:
      "autoSchema",
    confidence:
      "HIGH",
  },
);

const autoSchemaParseIssue =
  provenance.issues.find(
    (issue) =>
      issue.code ===
        "JSON_LD_PARSE_ERROR" &&
      issue.details?.sourceHint ===
        "data-added-by=autoSchema",
  );

assert.ok(
  autoSchemaParseIssue,
  "Expected provenance on JSON_LD_PARSE_ERROR.",
);

assert.equal(
  autoSchemaParseIssue
    .details
    ?.provenanceOwner,
  "EXTERNAL_INTEGRATION",
);

assert.equal(
  autoSchemaParseIssue
    .details
    ?.provenanceProvider,
  "autoSchema",
);

assert.equal(
  autoSchemaParseIssue
    .details
    ?.provenanceConfidence,
  "HIGH",
);

const brokenHtml = `
<!doctype html>
<html>
<head>

  <meta
    name="robots"
    content="noindex,follow"
  >

  <link
    rel="canonical"
    href="/products/a"
  >

  <link
    rel="canonical"
    href="/products/b"
  >

</head>
<body>

  <h1>Broken Product</h1>
  <h1>Second H1</h1>

  <script
    type="application/ld+json"
    id="schema-a"
  >
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "https://example.com/products/broken#product",
    "name": "Broken Product",
    "url": "https://example.com/products/broken",
    "offers": {
      "@type": "Offer",
      "price": "99.00",
      "priceCurrency": "SEK",
      "availability": "https://schema.org/InStock"
    }
  }
  </script>

  <script
    type="application/ld+json"
    id="schema-b"
  >
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "https://example.com/products/broken#product",
    "name": "Broken Product OLD",
    "url": "https://example.com/products/broken",
    "offers": {
      "@type": "Offer",
      "price": "149.00",
      "priceCurrency": "SEK",
      "availability": "https://schema.org/OutOfStock"
    }
  }
  </script>

  <script type="application/ld+json">
    { this is invalid json }
  </script>

</body>
</html>
`;

const broken = auditHtml({
  requestedUrl:
    "https://example.com/products/old-handle",

  finalUrl:
    "https://example.com/products/broken",

  statusCode: 200,

  html: brokenHtml,

  redirectChain: [
    "https://example.com/products/broken",
  ],

  expectedPageType: "PRODUCT",
});

const codes =
  new Set(
    broken.issues.map(
      (issue) => issue.code,
    ),
  );

for (
  const expectedCode
  of [
    "TITLE_MISSING",
    "META_DESCRIPTION_MISSING",
    "H1_MULTIPLE",
    "CANONICAL_MULTIPLE",
    "NOINDEX_PRESENT",
    "JSON_LD_PARSE_ERROR",
    "DUPLICATE_SCHEMA_ID",
    "CONFLICTING_PRODUCT_SCHEMA",
    "BREADCRUMB_SCHEMA_MISSING",
  ]
) {
  assert.equal(
    codes.has(expectedCode),
    true,
    `Expected issue code ${expectedCode}`,
  );
}

assert.equal(
  broken.jsonLd.parseFailures.length,
  1,
);

assert.equal(
  broken.jsonLd.typeCounts.Product,
  2,
);

console.log(
  "SEO_AUDIT_CORE_VERIFICATION=PASS",
);

console.log(
  JSON.stringify(
    {
      healthy: {
        schemaTypes:
          healthy.jsonLd.typeCounts,

        issues:
          healthy.issues.length,
      },

      broken: {
        schemaTypes:
          broken.jsonLd.typeCounts,

        issueCodes:
          [...codes].sort(),
      },
    },
    null,
    2,
  ),
);