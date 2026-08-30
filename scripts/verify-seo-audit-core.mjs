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