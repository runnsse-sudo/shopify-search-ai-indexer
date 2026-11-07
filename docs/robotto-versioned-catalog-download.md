# Robotto: version-bound llms-full.txt download (local proposal)

Status: prepared only. No theme, Shopify file, lock, schedule or deployment changed.

## Verified failure and correction

The previous pilot read new bytes through the GenericFile URL returned by Shopify,
while the unversioned storefront CDN URL still returned the previous bytes.
`Cache-Control: no-cache` alone did not establish freshness.

The local publisher now reads the pinned GenericFile
`gid://shopify/GenericFile/62861370655066` in `robotto-7143.myshopify.com`.
Only the exact CDN path `/s/files/1/0766/2777/1738/files/llms-full.txt`
with a single numeric `v` query parameter is accepted. It reads both that URL
and `https://www.robotto.se/cdn/shop/files/llms-full.txt?v=<returned-version>`.
Their SHA256 values must match, and the metadata URL must remain unchanged
across the reads. This also applies to the baseline backup and rollback.
No timestamp, random cache-buster or assumed future version is substituted.

## Public link proposal

For a separately approved change to Robotto's existing root wrapper template,
derive the download link at render time using Shopify Liquid's `file_url` filter:

```liquid
{{ 'llms-full.txt' | file_url | prepend: 'https:' }}
```

Shopify documents `file_url` as returning a protocol-relative Files CDN URL
including its version query. Use this result as the destination of the wrapper's
existing download link; retain its other content. Do not hardcode a version.
The publisher's matching versioned storefront URL is also suitable as a
version-specific download, but a saved URL points to that version rather than
automatically tracking subsequent replacements.

The root wrapper itself can be cached. Future verification must read the actual
rendered root response and verify its link points to the current version, then
check the linked bytes. Successful publisher readback alone does not certify
that the root wrapper or the unversioned URL has refreshed.

## Installation and rollback boundaries

Before a future theme change: reverify Robotto, active theme and exact existing
template; save its full bytes and SHA256. Change only the download destination
in `templates/llms-full.txt.liquid`. Verify the rendered link, file identity,
version and SHA256. Compare `/agents.md` and `/llms.txt` with their baselines.
Rollback restores only the backed-up template after checking for intervening
changes. No theme change, upload or publication is authorized by this proposal.

The retained publication lock is untouched. This correction does not authorize
its deletion or another pilot. A future publication still requires separate
authorization, verified backup and the existing exclusive-lock protections.

Sources: https://shopify.dev/docs/api/liquid/filters/file_url and
https://shopify.dev/docs/api/admin-graphql/latest/objects/GenericFile

## Local validation and release boundary

The publisher's synthetic tests cover stale unversioned caches, successful
versioned publication, lost-response rollback, malformed/foreign URLs,
inconsistent readback and metadata races (17 focused tests PASS).

The exact proposed Liquid expression passes Shopify Toolkit's stateless theme
validator as `templates/llms-full.txt.liquid`. A deliberately malformed `if`
tag is rejected by the same validator. No checks were disabled or modified.

The isolated host environment is
`C:/Users/danie/AppData/Local/Temp/ai-indexer-liquid-validator-20261107`.
It contains byte-identical copies of the installed Toolkit's `validate.mjs`
and `_validate_theme.mjs`, plus pinned `@shopify/theme-check-common`,
`@shopify/theme-check-docs-updater` and `@shopify/theme-check-node` at `4.0.0`.
`package-lock.json` records transitive versions; `qualification.json` records
the script hashes and positive/negative validation results. The original host
Toolkit and app dependencies are unchanged. Instrumentation was opted out.

This is local expression validation, not validation of a changed live template.
The existing root wrapper still needs its separately authorized backup, minimal
link change and actual storefront readback before it can be called live.
