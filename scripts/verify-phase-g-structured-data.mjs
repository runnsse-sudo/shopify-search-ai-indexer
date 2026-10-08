/* eslint-env node */
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { certifySchemaRetirement } from "../build-tests/schema-retirement.mjs";
import { auditHtml } from "../build-tests/seo-html-audit.mjs";

const extension = "extensions/runn-schema-storefront";
const rendererPath = process.env.RUNN_LIQUIDJS_MODULE;
assert.ok(
  rendererPath,
  "Set RUNN_LIQUIDJS_MODULE to host-installed LiquidJS dist/liquid.node.js; no downloads or skipped render tests",
);
const { Liquid } = createRequire(import.meta.url)(rendererPath);
const renderRoot = await mkdtemp(join(tmpdir(), "runn-phase-g-render-"));
const sources = {};
for (const folder of ["blocks", "snippets"]) {
  await mkdir(join(renderRoot, folder));
  for (const file of await readdir(extension + "/" + folder)) {
    if (!file.endsWith(".liquid")) continue;
    const source = await readFile(
      extension + "/" + folder + "/" + file,
      "utf8",
    );
    sources[file] = source;
    await writeFile(
      join(renderRoot, folder, file),
      source
        .replace(/{%\s*doc\s*%}[\s\S]*?{%\s*enddoc\s*%}/g, "")
        .replace(/{%\s*schema\s*%}[\s\S]*?{%\s*endschema\s*%}/g, ""),
    );
  }
}
const liquid = new Liquid({
  root: [join(renderRoot, "blocks"), join(renderRoot, "snippets")],
  extname: ".liquid",
  strictFilters: true,
});
liquid.registerFilter("json", (value) =>
  JSON.stringify(value === undefined ? null : value),
);
liquid.registerFilter("image_url", (image) => image.url);
const config = {
  version: 1,
  identity: {
    founder: "",
    facebookUrl: "",
    instagramUrl: "",
    xUrl: "",
    aboutUrl: "",
    contactUrl: "",
  },
  shipping: {
    enabled: true,
    country: "DE",
    rate: 7.5,
    currency: "EUR",
    label: "Configured delivery",
    minimumDeliveryDays: 1,
    maximumDeliveryDays: 3,
    policyUrl: "/policies/shipping-policy",
  },
  returns: {
    enabled: true,
    country: "DE",
    periodDays: 21,
    method: "ReturnByMail",
    fees: "CustomerResponsibility",
    refundType: "FullRefund",
    policyUrl: "/policies/refund-policy",
  },
};
const variant = {
  id: 11,
  title: "Default Title",
  sku: "SKU-11",
  barcode: "4006381333931",
  price: 3895,
  available: true,
  options: ["Default Title"],
};
const product = {
  id: 1,
  title: "Example & product",
  description: "<p>Useful description</p>",
  vendor: "Actual vendor",
  has_only_default_variant: true,
  variants_count: 1,
  variants: [variant],
  selected_or_first_available_variant: variant,
  options_with_values: [{ name: "Title" }],
  featured_image: { url: "//example.com/product.png" },
};
const context = {
  shop: { url: "https://example.com", name: "Example shop" },
  cart: { currency: { iso_code: "EUR" } },
  routes: { root_url: "/en-en/" },
  canonical_url: "https://example.com/en-en/products/example",
  request: { page_type: "product", path: "/en-en/products/example" },
  product,
  block: { settings: { exclusive_owner_confirmed: true, enable_output: true } },
  app: {
    metafields: {
      runn_storefront: { config_v1: { type: "json", value: config } },
    },
  },
};
let renderCount = 0;
async function render(file, overrides = {}) {
  const inputs = { ...context, ...overrides };
  liquid.options.globals = {
    shop: inputs.shop,
    routes: inputs.routes,
    cart: inputs.cart,
  };
  const html = await liquid.renderFile(file, inputs);
  renderCount++;
  const data = [
    ...html.matchAll(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ].map((match) => JSON.parse(match[1]));
  const audit = auditHtml({
    requestedUrl: context.canonical_url,
    finalUrl: context.canonical_url,
    statusCode: 200,
    html,
  });
  assert.equal(audit.jsonLd.parseFailures.length, 0, file);
  const definitions = audit.jsonLd.nodes
    .filter((node) => node.types.length && node.id)
    .map((node) => new URL(node.id, context.shop.url).href);
  assert.equal(
    new Set(definitions).size,
    definitions.length,
    "duplicate full definitions: " + file,
  );
  return { html, data, audit };
}
const appWith = (value, type = "json") => ({
  metafields: { runn_storefront: { config_v1: { type, value } } },
});
const types = (result) => result.audit.jsonLd.typeCounts;
for (const file of ["product-schema", "site-identity-schema"]) {
  assert.equal(
    (await render(file, { block: { settings: {} } })).data.length,
    0,
    "default-off gate",
  );
  const schema = JSON.parse(
    sources[file + ".liquid"].match(/{% schema %}([\s\S]*?){% endschema %}/)[1],
  );
  assert.ok(schema.settings.every((setting) => setting.default === false));
}
for (const kind of ["product", "collection", "page"]) {
  const result = await render("breadcrumb-schema", {
    request: { page_type: kind },
    collection: { title: "Collection" },
    page: { title: "Page" },
  });
  assert.equal(types(result).BreadcrumbList, 1);
  assert.deepEqual(
    result.data[0].itemListElement.map((item) => item.position),
    [1, 2],
  );
  assert.equal(
    result.data[0].itemListElement[0].item,
    "https://example.com/en-en/",
  );
  assert.equal(result.data[0]["@id"], context.canonical_url + "#breadcrumb");
}
for (const kind of ["index", "article", "search"])
  assert.equal(
    (await render("breadcrumb-schema", { request: { page_type: kind } })).data
      .length,
    0,
  );
assert.equal(
  (await render("breadcrumb-schema", { product: null })).data.length,
  0,
);
const home = {
  request: { page_type: "index", path: "/" },
  canonical_url: "https://example.com/",
};
const site = await render("site-identity-schema", home);
assert.equal(types(site).WebSite, 1);
assert.equal(types(site).OnlineStore, 1);
assert.equal(
  site.data[0]["@graph"][0].publisher["@id"],
  "https://example.com/#online-store",
);
assert.equal(types(site).ShippingService, 1);
assert.equal(types(site).MerchantReturnPolicy, 1);
assert.ok(
  !types(site).Product && !types(site).Offer && !types(site).BreadcrumbList,
);
assert.equal(
  (await render("site-identity-schema")).data.length,
  0,
  "homepage only",
);
const single = await render("product-schema");
assert.equal(types(single).Product, 1);
assert.equal(types(single).Offer, 1);
const singleProduct = single.data[0]["@graph"][0];
assert.equal(singleProduct.gtin13, "4006381333931");
assert.equal(singleProduct.offers.price, 38.95);
assert.equal(singleProduct.offers.priceCurrency, "EUR");
assert.ok(!singleProduct.offers.itemCondition);
assert.equal(
  singleProduct.offers.hasMerchantReturnPolicy["@id"],
  "https://example.com/#return-policy-de",
);
assert.equal(types(single).OfferShippingDetails, 1);
const variants = [
  { ...variant, id: 11, title: "Red", options: ["Red"] },
  {
    ...variant,
    id: 12,
    title: "Blue",
    sku: "SKU-12",
    options: ["Blue"],
    available: false,
    price: 4995,
  },
];
const groupedProduct = {
  ...product,
  has_only_default_variant: false,
  variants_count: 2,
  variants,
  selected_or_first_available_variant: variants[0],
  options_with_values: [{ name: "Color" }],
};
const group = await render("product-schema", { product: groupedProduct });
assert.equal(types(group).ProductGroup, 1);
assert.equal(types(group).Product, 2);
assert.equal(types(group).Offer, 2);
assert.deepEqual(group.data[0]["@graph"][0].variesBy, [
  "https://schema.org/color",
]);
assert.equal(group.data[0]["@graph"][0].hasVariant[1].color, "Blue");
assert.equal(
  group.data[0]["@graph"][0].hasVariant[1].offers.availability,
  "https://schema.org/OutOfStock",
);
assert.equal(types(group).MerchantReturnPolicy, 1);
assert.equal(types(group).OfferShippingDetails, 1);
for (const changed of [
  { options_with_values: [{ name: "Style" }] },
  { variants_count: 251 },
  { variants: [variants[0]] },
]) {
  const fallback = await render("product-schema", {
    product: { ...groupedProduct, ...changed },
  });
  assert.equal(types(fallback).Product, 1);
  assert.ok(!types(fallback).ProductGroup);
}
for (const [barcode, key] of [
  ["96385074", "gtin8"],
  ["036000291452", "gtin12"],
  ["4006381333931", "gtin13"],
  ["10012345000017", "gtin14"],
]) {
  const result = await render("product-schema", {
    product: {
      ...product,
      selected_or_first_available_variant: { ...variant, barcode },
    },
  });
  assert.equal(result.data[0]["@graph"][0][key], barcode);
}
for (const barcode of [
  "abc123",
  "123",
  "96385075",
  "036000291453",
  "4006381333932",
  "10012345000018",
  "123456789012345",
  "",
  "400638133393X",
]) {
  const result = await render("product-schema", {
    product: {
      ...product,
      selected_or_first_available_variant: { ...variant, barcode },
    },
  });
  assert.ok(
    !Object.keys(result.data[0]["@graph"][0]).some((key) =>
      key.startsWith("gtin"),
    ),
  );
}
// Structural corruption fails both gates; irrelevant fields do not.
for (const value of [
  undefined,
  null,
  { version: 2 },
  {},
  { ...config, shipping: null },
  { ...config, returns: [] },
]) {
  for (const path of ["/policies/shipping-policy", "/policies/refund-policy"])
    assert.equal(
      (
        await render("merchant-policy-schema", {
          app: appWith(value),
          request: { path },
        })
      ).data.length,
      0,
    );
}
for (const pair of [
  [null, null],
  [1, 3],
  [3, 6],
  [0, 0],
  [null, 3],
  [3, null],
  [1.5, 3],
  [-1, 3],
  [1, 366],
  [5, 2],
  ["1", "3"],
  [undefined, undefined],
]) {
  const value = {
    ...config,
    shipping: {
      ...config.shipping,
      minimumDeliveryDays: pair[0],
      maximumDeliveryDays: pair[1],
    },
  };
  for (const [path, type] of [
    ["/policies/shipping-policy", "ShippingService"],
    ["/policies/refund-policy", "MerchantReturnPolicy"],
  ]) {
    const result = await render("merchant-policy-schema", {
      app: appWith(value),
      request: { path },
    });
    assert.equal(types(result)[type], 1);
    assert.ok(
      !/"(?:handlingTime|transitTime|deliveryTime|minimumDeliveryDays|maximumDeliveryDays)"/.test(
        result.html,
      ),
    );
  }
}
for (const bad of [
  { enabled: "true" },
  { enabled: 1 },
  { rate: "7.5" },
  { rate: -1 },
  { rate: 1000001 },
  { country: "123" },
  { country: ["DE"] },
  { label: "" },
  { currency: "12" },
]) {
  const app = appWith({ ...config, shipping: { ...config.shipping, ...bad } });
  assert.equal(
    (
      await render("merchant-policy-schema", {
        app,
        request: { path: "/policies/shipping-policy" },
      })
    ).data.length,
    0,
  );
  assert.equal(
    types(
      await render("merchant-policy-schema", {
        app,
        request: { path: "/policies/refund-policy" },
      }),
    ).MerchantReturnPolicy,
    1,
  );
  assert.equal(
    types(await render("product-schema", { app })).MerchantReturnPolicy,
    1,
  );
  assert.equal(
    types(await render("site-identity-schema", { ...home, app }))
      .MerchantReturnPolicy,
    1,
  );
}
for (const bad of [
  { enabled: "true" },
  { periodDays: 0 },
  { periodDays: 1.5 },
  { method: "unknown" },
  { fees: "unknown" },
  { refundType: "unknown" },
  { country: "123" },
  { policyUrl: "//evil.example" },
]) {
  const app = appWith({ ...config, returns: { ...config.returns, ...bad } });
  assert.equal(
    (
      await render("merchant-policy-schema", {
        app,
        request: { path: "/policies/refund-policy" },
      })
    ).data.length,
    0,
  );
  assert.equal(
    types(
      await render("merchant-policy-schema", {
        app,
        request: { path: "/policies/shipping-policy" },
      }),
    ).ShippingService,
    1,
  );
  assert.equal(
    types(await render("product-schema", { app })).OfferShippingDetails,
    1,
  );
  assert.equal(
    types(await render("site-identity-schema", { ...home, app }))
      .ShippingService,
    1,
  );
}
for (const identity of [
  undefined,
  null,
  { founder: 123 },
  { facebookUrl: "javascript:bad" },
]) {
  const result = await render("merchant-policy-schema", {
    app: appWith({ ...config, identity }),
    request: { path: "/policies/refund-policy" },
  });
  assert.equal(types(result).MerchantReturnPolicy, 1);
}
const legacyShipping = await render("merchant-policy-schema", {
  request: { path: "/policies/shipping-policy" },
});
const unknownShipping = await render("merchant-policy-schema", {
  request: { path: "/policies/shipping-policy" },
  app: appWith({
    ...config,
    shipping: {
      ...config.shipping,
      minimumDeliveryDays: null,
      maximumDeliveryDays: null,
    },
  }),
});
assert.deepEqual(legacyShipping.data, unknownShipping.data);
for (const path of ["/pages/leveransinfo", "/policies/shipping-policy"])
  assert.equal(
    types(await render("merchant-policy-schema", { request: { path } }))
      .ShippingService,
    1,
  );
assert.equal(
  types(
    await render("merchant-policy-schema", {
      request: { path: "/policies/refund-policy" },
    }),
  ).MerchantReturnPolicy,
  1,
);
assert.equal(
  (
    await render("merchant-policy-schema", {
      request: { path: "/policies/terms-of-service" },
    })
  ).data.length,
  0,
);
assert.equal(
  (
    await render("merchant-policy-schema", {
      app: appWith(config, "single_line_text_field"),
      request: { path: "/policies/refund-policy" },
    })
  ).data.length,
  0,
);
const disabled = {
  ...config,
  shipping: { ...config.shipping, enabled: false },
  returns: { ...config.returns, enabled: false },
};
assert.ok(
  !types(await render("product-schema", { app: appWith(disabled) }))
    .MerchantReturnPolicy,
);
assert.equal(
  (await render("product-schema", { cart: { currency: {} } })).data.length,
  0,
);
const noOptional = await render("product-schema", {
  product: {
    ...product,
    vendor: "",
    description: "",
    featured_image: null,
    selected_or_first_available_variant: {
      ...variant,
      sku: "",
      barcode: "",
      price: 0,
    },
  },
});
assert.ok(
  !noOptional.data[0]["@graph"][0].sku &&
    !noOptional.data[0]["@graph"][0].image,
);
assert.equal(noOptional.data[0]["@graph"][0].offers.price, 0);

for (const value of [
  "https://",
  "http://",
  "https://example.com?bad",
  "javascript:alert(1)",
  "//example.com",
  "data:text/html,unsafe",
  "https://-bad.example/path",
  "https://example..com/path",
  "https://example.com:bad/path",
  "https://example.com\t/path",
  "https://example.com/\u0000bad",
  "https://user@example.com/path",
  "https://example.com\\bad",
  "/\\evil.example",
]) {
  const invalidUrl = {
    ...config,
    returns: { ...config.returns, policyUrl: value },
  };
  assert.equal(
    (
      await render("merchant-policy-schema", {
        app: appWith(invalidUrl),
        request: { path: "/policies/refund-policy" },
      })
    ).data.length,
    0,
    "unsafe configured URL: " + value,
  );
}
for (const file of [
  "breadcrumb-schema",
  "site-identity-schema",
  "product-schema",
  "merchant-policy-schema",
]) {
  const injected = await render(file, {
    ...(file === "site-identity-schema" ? home : {}),
    shop: {
      url: "https://example.com",
      name: "Shop </script><script>unsafe</script>",
    },
    product: { ...product, title: 'Product </script> & quote"' },
    request: {
      page_type: file === "site-identity-schema" ? "index" : "product",
      path: "/policies/refund-policy",
    },
  });
  assert.equal(injected.data.length, 1, "script-safe JSON: " + file);
}
const zeroRateConfig = { ...config, shipping: { ...config.shipping, rate: 0 } };
assert.equal(
  types(await render("product-schema", { app: appWith(zeroRateConfig) }))
    .OfferShippingDetails,
  1,
);
const blankPolicyUrl = {
  ...config,
  returns: { ...config.returns, policyUrl: "" },
};
const blankPolicy = await render("merchant-policy-schema", {
  app: appWith(blankPolicyUrl),
  request: { path: "/policies/refund-policy" },
});
assert.ok(!blankPolicy.data[0].hasMerchantReturnPolicy.merchantReturnLink);
const noConfigSite = await render("site-identity-schema", { ...home, app: {} });
assert.equal(types(noConfigSite).WebSite, 1);
assert.ok(!types(noConfigSite).MerchantReturnPolicy);

const currencyMismatchRender = await render("product-schema", {
  cart: { currency: { iso_code: "USD" } },
});
assert.equal(
  currencyMismatchRender.data[0]["@graph"][0].offers.priceCurrency,
  "USD",
);
assert.ok(
  !types(currencyMismatchRender).OfferShippingDetails,
  "do not relabel configured EUR shipping as USD",
);
assert.equal(types(currencyMismatchRender).MerchantReturnPolicy, 1);

const script = (value, provider = "") =>
  '<script type="application/ld+json"' +
  (provider ? ' data-added-by="' + provider + '"' : "") +
  ">" +
  JSON.stringify(value) +
  "</script>";
const page = (html, extra = {}) => ({
  requestedUrl: "https://example.com/products/example",
  finalUrl: "https://example.com/products/example",
  statusCode: 200,
  html,
  ...extra,
});
const auto = script(
  {
    "@type": "Product",
    "@id": "https://example.com/products/example#product",
    sku: "A",
    offers: {
      "@type": "Offer",
      "@id": "https://example.com/products/example#offer",
      price: 38.95,
      priceCurrency: "SEK",
    },
  },
  "autoSchema",
);
const other = script({
  "@type": "Product",
  "@id": "/products/example#product",
  sku: "A",
  offers: {
    "@type": "Offer",
    "@id": "/products/example#offer",
    price: "38.95",
    priceCurrency: "EUR",
  },
});
assert.equal(certifySchemaRetirement([]).decision, "BLOCKED");
const dependent = certifySchemaRetirement([page(auto)]);
assert.ok(
  dependent.findings.some(
    (finding) => finding.code === "SCHEMA_DEPENDENCY_OR_MISSING",
  ),
);
const comparison = certifySchemaRetirement([page(auto + other)]);
assert.ok(
  comparison.findings.some(
    (finding) => finding.code === "LOCALIZED_CURRENCY_MISMATCH",
  ),
);
assert.ok(comparison.pages[0].duplicatesBefore.length);
assert.equal(comparison.pages[0].duplicatesAfter.length, 0);
const duplicate = certifySchemaRetirement([page(other + other)]);
assert.ok(
  duplicate.findings.some(
    (finding) => finding.code === "PERSISTENT_DUPLICATE_ID",
  ),
);
const conflict = certifySchemaRetirement([
  page(other + other.replace("38.95", "99.95")),
]);
assert.ok(
  conflict.findings.some(
    (finding) => finding.code === "PERSISTENT_CONFLICTING_PRODUCT_SCHEMA",
  ),
);
const invalid = certifySchemaRetirement([
  page('<script type="application/ld+json">{bad}</script>'),
]);
assert.ok(
  invalid.findings.some((finding) => finding.code === "JSON_LD_PARSE_FAILURE"),
);
const windowConflict = certifySchemaRetirement([
  page(
    script(
      {
        "@type": "MerchantReturnPolicy",
        applicableCountry: "DE",
        merchantReturnDays: 14,
      },
      "autoSchema",
    ) +
      script(
        {
          "@type": "MerchantReturnPolicy",
          applicableCountry: "DE",
          merchantReturnDays: 30,
        },
        "runn-schema-storefront",
      ),
  ),
]);
assert.ok(
  windowConflict.findings.some(
    (finding) =>
      finding.code === "RETURN_WINDOW_MISMATCH_REQUIRES_VERIFICATION",
  ),
);
const parity = certifySchemaRetirement([
  page(group.html + (await render("breadcrumb-schema")).html, {
    expectedPageType: "PRODUCT",
    expectedCurrency: "EUR",
  }),
]);
assert.equal(
  parity.decision,
  "SAMPLE_PARITY_PASSED",
  JSON.stringify(parity.findings),
);
assert.equal(parity.automaticDisableAuthorized, false);
for (const type of [
  "ProductGroup",
  "AggregateOffer",
  "BreadcrumbList",
  "WebSite",
  "OnlineStore",
  "ShippingService",
  "OfferShippingDetails",
]) {
  assert.ok(
    certifySchemaRetirement([
      page(script({ "@type": type }, "autoSchema")),
    ]).findings.some(
      (finding) => finding.code === "SCHEMA_DEPENDENCY_OR_MISSING",
    ),
  );
}

const cliManifest = join(renderRoot, "manifest.json");
await writeFile(
  join(renderRoot, "fixture.html"),
  group.html + (await render("breadcrumb-schema")).html,
);
await writeFile(
  cliManifest,
  JSON.stringify({
    pages: [
      {
        requestedUrl: "https://example.com/products/example",
        statusCode: 200,
        expectedPageType: "PRODUCT",
        expectedCurrency: "EUR",
        htmlFile: "fixture.html",
      },
    ],
  }),
);
const cliReport = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/certify-autoschema-retirement.mjs", cliManifest],
    { encoding: "utf8" },
  ),
);
assert.equal(cliReport.decision, "SAMPLE_PARITY_PASSED");
assert.equal(cliReport.automaticDisableAuthorized, false);
await writeFile(
  join(renderRoot, "fixture.html"),
  '<script type="application/ld+json">invalid JSON</script>',
);
assert.throws(
  () =>
    execFileSync(
      process.execPath,
      ["scripts/certify-autoschema-retirement.mjs", cliManifest],
      { encoding: "utf8", stdio: "pipe" },
    ),
  (error) => error.status === 1,
);
const aggregateProduct = script({
  "@type": "Product",
  sku: "AGG",
  offers: {
    "@type": "AggregateOffer",
    lowPrice: 10,
    highPrice: 20,
    priceCurrency: "EUR",
    offerCount: 2,
  },
});
const aggregateParity = certifySchemaRetirement([
  page(aggregateProduct + (await render("breadcrumb-schema")).html, {
    expectedPageType: "PRODUCT",
  }),
]);
assert.equal(aggregateParity.decision, "SAMPLE_PARITY_PASSED");

// Review regressions exercise rendered objects, not implementation strings.
for (const [currency, price, expected] of [
  ["SEK", 44900, 449],
  ["EUR", 3895, 38.95],
]) {
  const result = await render("product-schema", {
    cart: { currency: { iso_code: currency } },
    shop: { ...context.shop, currency: "SEK" },
    product: {
      ...product,
      selected_or_first_available_variant: { ...variant, price },
    },
  });
  assert.equal(result.data[0]["@graph"][0].offers.priceCurrency, currency);
  assert.equal(result.data[0]["@graph"][0].offers.price, expected);
  assert.equal(
    result.data[0]["@graph"][0].url,
    context.canonical_url + "?variant=11",
  );
}
for (const shipping of [false, true])
  for (const returns of [false, true]) {
    const value = {
      ...config,
      shipping: { ...config.shipping, enabled: shipping },
      returns: { ...config.returns, enabled: returns },
    };
    const result = await render("site-identity-schema", {
      ...home,
      app: appWith(value),
    });
    assert.equal(types(result).WebSite, 1);
    assert.equal(types(result).OnlineStore, 1);
    assert.equal(types(result).ShippingService ?? 0, Number(shipping));
    assert.equal(types(result).MerchantReturnPolicy ?? 0, Number(returns));
    assert.equal(
      result.data[0]["@graph"][0].publisher["@id"],
      result.data[0]["@graph"][1]["@id"],
    );
  }
const specialTitle = 'Tärning "eld" &amp; spel 🎲';
for (const kind of ["product", "collection", "page"]) {
  const result = await render("breadcrumb-schema", {
    request: { page_type: kind },
    product: { ...product, title: specialTitle },
    collection: { title: specialTitle },
    page: { title: specialTitle },
  });
  assert.equal(result.data[0].itemListElement[1].name, specialTitle);
  assert.equal(
    (
      await render("breadcrumb-schema", {
        request: { page_type: kind },
        [kind]: null,
      })
    ).data.length,
    0,
  );
}
for (const overrides of [
  { canonical_url: null },
  { canonical_url: "" },
  { product: null },
  { product: { ...product, requires_selling_plan: true } },
  {
    product: {
      ...product,
      selected_or_first_available_variant: { ...variant, id: null },
    },
  },
  {
    product: {
      ...product,
      selected_or_first_available_variant: { ...variant, price: null },
    },
  },
])
  assert.equal((await render("product-schema", overrides)).data.length, 0);
for (const value of [null, [], [{ name: "" }]]) {
  const result = await render("product-schema", {
    product: { ...groupedProduct, options_with_values: value },
  });
  assert.equal(types(result).Product, 1);
  assert.ok(!types(result).ProductGroup);
}
for (const url of [
  "//cdn.example.com/å.png",
  "https://cdn.example.com/å.png",
]) {
  const result = await render("product-schema", {
    product: { ...product, title: specialTitle, featured_image: { url } },
  });
  assert.equal(
    result.data[0]["@graph"][0].image,
    "https://cdn.example.com/å.png",
  );
  assert.equal(result.data[0]["@graph"][0].name, specialTitle);
  assert.ok(!result.data[0]["@graph"][0].brand, "vendor is not proof of brand");
}
for (const path of [
  "/pages/leveransinfo-other",
  "/policies/refund-policy-extra",
  "/other/policies/refund-policy",
]) {
  assert.equal(
    (await render("merchant-policy-schema", { request: { path } })).data.length,
    0,
  );
}
for (const [path, type] of [
  ["/en-en/policies/refund-policy", "MerchantReturnPolicy"],
  ["/en-en/pages/leveransinfo", "ShippingService"],
]) {
  assert.equal(
    types(await render("merchant-policy-schema", { request: { path } }))[type],
    1,
  );
}
for (const url of [
  "https://example.com/returns",
  "/policies/refund-policy",
  "",
]) {
  const result = await render("merchant-policy-schema", {
    request: { path: "/policies/refund-policy" },
    app: appWith({ ...config, returns: { ...config.returns, policyUrl: url } }),
  });
  assert.equal(types(result).MerchantReturnPolicy, 1);
}
const fakeMarker = certifySchemaRetirement([
  page(script({ "@type": "WebSite", name: "Persistent" }, "autoschema-other")),
]);
assert.equal(
  fakeMarker.pages[0].matrix.find((row) => row.type === "WebSite")
    .OTHER_PERSISTENT,
  1,
);
assert.equal(
  fakeMarker.pages[0].matrix.find((row) => row.type === "WebSite").AUTO_SCHEMA,
  0,
);
const typedReferences = certifySchemaRetirement([
  page(
    script({
      "@graph": [
        {
          "@type": "WebSite",
          "@id": "#website",
          name: "Site",
          publisher: { "@type": "OnlineStore", "@id": "#store" },
        },
        { "@type": "OnlineStore", "@id": "#store", name: "Store" },
      ],
    }),
    { expectedPageType: "HOME" },
  ),
]);
assert.equal(
  typedReferences.decision,
  "SAMPLE_PARITY_PASSED",
  JSON.stringify(typedReferences.findings),
);
assert.equal(typedReferences.pages[0].duplicatesAfter.length, 0);
assert.equal(
  certifySchemaRetirement([
    page(script({ "@type": "Product", "@id": "#product" }), {
      expectedPageType: "PRODUCT",
    }),
  ]).decision,
  "BLOCKED",
);
const arrayCountries = certifySchemaRetirement([
  page(
    script({
      "@graph": [
        {
          "@type": "MerchantReturnPolicy",
          applicableCountry: ["DE", "SE"],
          merchantReturnDays: 14,
        },
        {
          "@type": "MerchantReturnPolicy",
          applicableCountry: "se",
          merchantReturnDays: 30,
        },
      ],
    }),
  ),
]);
assert.ok(
  arrayCountries.findings.some(
    (f) => f.code === "RETURN_WINDOW_MISMATCH_REQUIRES_VERIFICATION",
  ),
);
const persistentParse = certifySchemaRetirement([
  page(auto + '<script type="application/ld+json">broken</script>'),
]);
assert.ok(
  persistentParse.findings.some(
    (f) => f.code === "PERSISTENT_JSON_LD_PARSE_FAILURE",
  ),
);

for (const root of ["/", "/en-en", "/en-en/"]) {
  const path =
    root === "/" ? "/policies/refund-policy" : "/en-en/policies/refund-policy";
  assert.equal(
    types(
      await render("merchant-policy-schema", {
        routes: { root_url: root },
        request: { path },
      }),
    ).MerchantReturnPolicy,
    1,
  );
}
const linkedProduct = certifySchemaRetirement([
  page(
    other +
      script({ "@type": "Product", "@id": "/products/example#product" }) +
      (await render("breadcrumb-schema")).html,
    { expectedPageType: "PRODUCT" },
  ),
]);
assert.equal(
  linkedProduct.decision,
  "SAMPLE_PARITY_PASSED",
  JSON.stringify(linkedProduct.findings),
);
const storeDuplicates = certifySchemaRetirement([
  page(
    script({
      "@graph": [
        {
          "@type": "OnlineStore",
          "@id": "#store-a",
          url: "https://example.com/",
          name: "Store",
        },
        {
          "@type": "OnlineStore",
          "@id": "#store-b",
          url: "https://example.com/",
          name: "Store",
        },
      ],
    }),
  ),
]);
assert.ok(
  storeDuplicates.findings.some(
    (f) => f.code === "PERSISTENT_DUPLICATE_ONLINE_STORE",
  ),
);

const doc = await readFile("docs/PHASE-G-STRUCTURED-DATA-OWNERSHIP.md", "utf8");
for (const text of [
  "NOT ALLOWED",
  "RETURN_POLICY_VALUE_VERIFIED=REQUIRED",
  "No source file",
  "default-false",
  "parity certification",
])
  assert.ok(doc.includes(text));
for (const source of Object.values(sources)) {
  assert.ok(!/"(?:handlingTime|transitTime|deliveryTime)"/.test(source));
  assert.ok(
    !/['"](?:SE|SEK)['"]|assign\s+\w+\s*=\s*(?:49|14|30)\b/.test(source),
  );
}
assert.ok(sources["product-schema.liquid"].includes("cart.currency.iso_code"));
assert.ok(!sources["product-schema.liquid"].includes("shop.currency"));

// Timing validation is available independently, never a publication prerequisite.
for (const [min, max, expected] of [
  [null, null, true],
  [1, 3, true],
  [3, 6, true],
  [0, 0, true],
  [null, 3, false],
  [3, null, false],
  [1.5, 3, false],
  [-1, 3, false],
  [1, 366, false],
  [5, 2, false],
  ["1", "3", false],
  [undefined, undefined, false],
]) {
  const shipping = {
    ...config.shipping,
    minimumDeliveryDays: min,
    maximumDeliveryDays: max,
  };
  if (min === undefined) {
    delete shipping.minimumDeliveryDays;
    delete shipping.maximumDeliveryDays;
  }
  const output = await liquid.renderFile("runn-schema-config-valid", {
    config: { ...config, shipping },
    kind: "timing",
  });
  assert.equal(output.trim() === "true", expected);
}

console.log("PHASE_G_STRUCTURED_DATA_VERIFICATION=PASS");
console.log("ACTUAL_LIQUID_RENDER_CASES=" + renderCount);
console.log("RETIREMENT_FIXTURES=PASS; PRODUCTION_ENABLEMENT_AUTHORIZED=NO");
