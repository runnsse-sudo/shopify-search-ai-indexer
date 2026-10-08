# Phase G structured-data ownership and rollout contract

Status: source foundation only. Production autoSchema retirement remains blocked.
No source file, passing offline fixture, or extension version authorizes live enablement.

## Current and future ownership

| Role                 | Current owner                                                     | Runn source role                                                |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Product / Offer      | Existing Shopify storefront/theme                                 | Future exclusive owner; default off                             |
| ProductGroup         | Must be certified against actual variants                         | Conditional grouped strategy; default off                       |
| BreadcrumbList       | Runn on supported product/collection/page templates after rollout | Home > current canonical page; no invented collection hierarchy |
| WebSite              | Runn after controlled rollout                                     | Homepage only; default off                                      |
| OnlineStore          | Runn identity and configured policy relationships                 | Shared shop.url + /#online-store                                |
| Organization         | Existing legitimate non-conflicting theme entity may remain       | No additional Organization writer                               |
| MerchantReturnPolicy | Explicit verified Storefront Settings                             | Shared /#return-policy-{country}                                |
| ShippingService      | Explicit verified Storefront Settings                             | Shared /#shipping-standard-{country}                            |
| OfferShippingDetails | Future Runn exclusive Offers                                      | Separate /#offer-shipping-standard-{country} definition         |

Runn Product writer + existing full theme Product writer = NOT ALLOWED in final production.
Runn Product writer + autoSchema Product writer = NOT ALLOWED in final production.
The checkbox exclusive_owner_confirmed is a default-false operator assertion, not automatic detection of another writer. Liquid cannot reliably inspect other scripts. It must never be used to waive the certification gates.
Side-by-side full writers are allowed only in controlled offline/canary certification; they are not an acceptable final state. The existing audit detector is unchanged and has no Runn duplicate whitelist.

## Explicit configuration and business facts

Storefront Settings remains version 1; the app-owned metafield identity and Shopify scopes are unchanged. Delivery timing now permits explicit null/null, and the UI reflects this contract.
Absent, wrong-type, unsupported or invalid policy-bearing configuration emits no merchant-policy facts. Editing defaults are not publication defaults.
The shared Liquid validator checks each publication kind independently: shipping requires its enabled flag, country, currency, rate and label; returns requires its enabled flag, country, period, supported enums and optional return URL. Both policy sections must be JSON objects. Configured URLs use a conservative HTTP(S) DNS-host or relative-path subset: no credentials, ports, IP literals, malformed DNS labels, control characters or backslashes; maximum length 2048. Unsupported forms fail closed even if the settings form accepted them. Malformed facts suppress only their own policy enrichment. Identity fields, stored shipping policy URL and stored timing do not gate publication. The settings reader/writer still validates the complete persisted V1 shape. Country/currency codes are format-validated, as in V1; actual jurisdictions, currencies and business facts require merchant verification.
Optional blank policy URLs are omitted, never replaced with a guessed URL. Identity emits only shop name/public URLs; optional founder, address, telephone and social facts are deliberately omitted in V1.

RETURN_POLICY_VALUE_VERIFIED=REQUIRED
Game Dungeon's observed autoSchema 30-day versus Runn 14-day inconsistency is a store configuration issue. This code chooses neither value. Verify the actual policy and explicitly save the correct configuration in a separately authorized rollout before policy/site/product enrichment is enabled.
Removing legacy fallback is intentionally incompatible with relying on absent metafields: after a later deployment, that reliance will stop producing policy markup. Audit every shop before deploying this change.
DELIVERY_TIMING_UNKNOWN = null/null. Both properties remain mandatory in persisted V1 JSON; missing, mixed null/numeric, strings, fractions, out-of-range or reversed pairs are rejected by normalization. Editing defaults use null/null and show blank inputs. Legacy integer pairs (0–365, minimum ≤ maximum), including 0/0, remain accepted without a version bump; 0/0 is numeric, never unknown. These fields are storage-only, not handling time, transit time, warehouse lead time or a Google shipping eligibility claim. Do not populate them from warehouse lead times. A future publication model must distinguish fulfillment/handling, transit and calendar/business-day semantics. Liquid publication deliberately ignores timing, even invalid timing, so otherwise valid merchant facts survive.

Generic minimumDeliveryDays/maximumDeliveryDays are validated by the persisted settings contract but never mapped to handlingTime, transitTime or deliveryTime. No condition field is emitted because catalog-wide NewCondition semantics have not been established.
Shipping amount and currency are used exactly as configured; never relabel or convert a configured amount to the presentment currency. Offer shipping enrichment fails closed when the configured shipping currency differs from cart.currency.iso_code. Verify cross-market applicability before rollout. OfferShippingDetails without deliveryTime is valid schema.org output but does not establish eligibility for Google's shipping details enhancement; delivery timing needs a separately verified model before that enhancement can be certified. ShippingService and OfferShippingDetails have distinct IDs because they are different schema.org entities describing the same explicitly configured service facts.

## Product strategy

Single variant: one Product with one Offer. Prices use variant.price / 100.0 and cart.currency.iso_code (presentment currency), never shop.currency. Canonical localized URLs form entity IDs and variant query URLs.
Multi-variant: ProductGroup with nested Products, unique variant IDs and Offers, hasVariant/isVariantOf and explicit variesBy. Grouped output is used only when all option names map exactly (case-insensitively) to color, size, material or pattern, every variant is loaded, and there are at most 50 variants. Unknown/localized option labels and larger/incomplete sets fall back deterministically to the selected_or_first_available_variant Product, with its variant-specific URL. This is deliberately not full high-variant or combined-listing certification.
Barcode output requires numeric GTIN8/12/13/14 length and GS1 check-digit validation. Invalid barcodes are omitted; absent sku/image/description fields are omitted. Vendor is not proof of brand, so no Brand is emitted in V1. Subscription-only products emit no one-time Offer because selling-plan pricing is outside this foundation. No arbitrary barcode, MPN, condition or timing is invented.
Shared policy definitions appear once per product graph; Offer references use @id. Reference-only objects (including typed @id links without descriptive properties) are legitimate graph links, not duplicate definitions. OnlineStore satisfies the Organization requirement through schema.org inheritance. The certification tool separately reports raw existing audit findings and normalized duplicate full definitions; it does not alter the audit detector.

## Verification and captured-HTML certification

Run existing verifiers and:

    npm run verify:phase-g-structured-data
    npm run certify:autoschema-retirement -- <manifest.json>

The Phase G renderer is agent-host tooling, not a repository dependency (AGENTS.md). Install LiquidJS 10.24.0 in an agent tools directory, then set RUNN_LIQUIDJS_MODULE to the absolute path of its dist/liquid.node.js module. Tests render the actual Liquid sources using synthetic Shopify-shaped data, with JSON/image_url adapters. Toolkit validation separately checks Shopify Liquid/schema compatibility. Neither substitutes for Shopify-rendered canary verification.
The verifier fails if the host renderer is unavailable; it never silently skips rendering or downloads packages. Both commands are offline and perform no production writes. The build command only compiles pure audit modules into ignored build-tests outputs.

Manifest example (fixture values only):

    {"pages":[{"requestedUrl":"https://example.com/products/example","finalUrl":"https://example.com/products/example","statusCode":200,"expectedPageType":"PRODUCT","expectedCurrency":"EUR","htmlFile":"product.html","requiredTypes":["MerchantReturnPolicy","OfferShippingDetails"]}]}

Capture public HTML separately with authorized GET/HEAD only. The CLI reads captures, never fetches URLs, writes config, disables autoSchema or enables blocks. Compare AUTO_SCHEMA, RUNN and OTHER_PERSISTENT by explicit markers. OTHER_PERSISTENT means non-autoSchema captured output; unmarked source attribution and persistence require repeated captures/source inspection.
The result SAMPLE_PARITY_PASSED is limited to supplied captures and requirements, not retirement authorization. Include home, collection, ordinary pages, policy pages, single/multiple variants, unavailable variants, and localized markets/currencies. The tool detects missing/dependent roles, parse failures, normalized duplicate definitions, competing persistent writers, Product conflicts, currency mismatches and comparable return-window mismatches. Repeat captures to establish persistence. Compare optional fields and business semantics manually as well as type presence.

## Mandatory future rollout gates

1. Verify actual merchant business facts, including RETURN_POLICY_VALUE_VERIFIED=REQUIRED.
2. Complete capture coverage and exact side-by-side parity for variant identity, localized prices/currencies, availability and policy relationships.
3. Disable autoSchema Product/Offer output and explicitly resolve existing theme/storefront Product/Offer ownership before enabling the Runn writer. Perform the switchover only under separate authorization, with rollback prepared; never intentionally retain two full writers.
4. Review homepage identity and broader breadcrumbs against remaining theme output; explicitly activate their embeds and default-false identity setting only after parity certification.
5. Verify actual Shopify-rendered pages with autoSchema disabled in a controlled test; require no persistent duplicates, conflicts or parse failures before retirement.
6. Keep autoSchema enabled until all relevant parity and ownership gates pass. No automatic retirement or activation is implemented here.

Reference contracts: [Shopify cart currency](https://shopify.dev/docs/api/liquid/objects/cart#cart-currency), [variant presentment prices](https://shopify.dev/docs/api/liquid/objects/variant#variant-price), [variant count](https://shopify.dev/docs/api/liquid/objects/product#product-variants_count), [Google ProductGroup examples](https://developers.google.com/search/docs/appearance/structured-data/product-variants), [Offer return-policy domain](https://schema.org/hasMerchantReturnPolicy), [Offer shipping-details domain](https://schema.org/shippingDetails).
