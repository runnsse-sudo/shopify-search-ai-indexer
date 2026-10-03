# Runn Search AI Indexer — SEO / Sitemap / AI Roadmap

This document is the locked implementation order for the next
development phases. Changes to phase order should be deliberate and
reviewed rather than introduced incidentally by unrelated patches.

## Existing foundation

Already implemented before this roadmap:

- Shopify product create/update/delete monitoring
- durable product state and change fingerprints
- index/deindex queue
- initial catalog scan and repair workers
- provider planning and hard-gated IndexNow execution
- multi-shop provider architecture
- SEO Audit
- Storefront Settings V1
- Merchant Policy structured data
- Breadcrumb theme extension
- shipping and returns configuration

Production Robotto currently keeps autoSchema enabled while Runn
replaces its remaining responsibilities incrementally.

## Phase A — Sitemap foundation

1. XML sitemap parser
2. child sitemap discovery
3. URL inventory
4. image inventory
5. Sitemap & Indexing admin UI
6. HTTP / redirect / canonical / noindex comparison

Initial implementation is read-only and does not persist sitemap state.

## Phase B — 404 foundation

1. 404 discovery
2. redirect discovery
3. redirect chain and loop detection
4. broken internal-link detection
5. redirect suggestions
6. confidence model

No automatic redirect writes until the suggestion model has been
production-verified.

## Phase C — LLM / AI discovery

1. llms.txt
2. llms-full.txt
3. AI crawler audit
4. AI visibility dashboard

All LLM discovery output must use the same canonical/indexability source
of truth as sitemap and SEO Audit.

## Phase D — Sitemap publishing and indexing controls

1. complementary image sitemap
2. human-readable HTML sitemap
3. robots.txt integration
4. index / noindex controls
5. follow / nofollow controls where justified

Shopify's native sitemap remains the primary sitemap foundation unless a
specific verified limitation requires complementary output.

## Phase E — Search engines

1. Google Search Console integration
2. Google sitemap submission/status
3. Bing sitemap integration
4. integration of IndexNow with the unified URL inventory

Google is not treated as a generic product-push provider.

## Phase F — Redirect writes

1. Shopify redirect inventory
2. required Shopify scope migration
3. redirect-write dry-run
4. manual approval
5. safe redirect autopilot

Never redirect all unknown 404 URLs to the home page.

## Phase G — Structured-data replacement

1. Product / ProductGroup
2. Offer
3. Breadcrumb
4. Organization / OnlineStore / WebSite
5. side-by-side comparison with autoSchema
6. disable autoSchema only after parity is verified

Runn Merchant Policy is already live and verified.

## Phase H — External app retirement

### Nabu Sitemap

Only remove after Runn verifies:

- Shopify sitemap audit
- image sitemap requirements
- HTML sitemap
- index/noindex controls
- robots handling
- Google/Bing sitemap workflow

### autoSchema

Only remove after Runn verifies:

- Product / ProductGroup
- Offer
- Breadcrumb
- Organization / WebSite
- Merchant Policy
- no duplicate structured-data entities

## Implementation safety contract

Every production-affecting phase follows:

read-only inventory
→ deterministic verifier
→ isolated feature branch
→ dry-run
→ exact diff review
→ commit
→ push
→ pull request
→ merge
→ canary
→ live verification
→ writes/autopilot last

Do not combine unrelated migrations, scope changes or production writes
into an audit-only phase.
