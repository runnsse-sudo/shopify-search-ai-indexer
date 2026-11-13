# Automatic 404 & Redirect Audit

The Shopify Admin page runs a read-only audit. A separate one-shot worker is
packaged in the image for scheduled execution. The web process does not start it.

Configure an independent job with command `node` and arguments
`./build-workers/automatic-redirect-worker.mjs` and
`--run-enabled-redirect-audits-once`. Set `AUTOMATIC_REDIRECT_SHOPS` to the
comma-separated list of up to six explicitly enabled `.myshopify.com` domains.
Use a single task, no automatic retries, and a daily schedule with enough time
for up to three minutes of audit work per shop plus startup and authentication.
The job uses the app's existing offline sessions. Each installation must have
`read_online_store_navigation` and `write_online_store_navigation` granted.

At most five candidates per shop are rechecked in a run. A candidate must have
one clearly preferred same-store, same-locale resource of the same type. The
source must still return a direct 404 and the target must return a direct HTML
200. Existing Shopify redirects are skipped. The job creates redirects only
and records each confirmed Shopify ID in its structured logs. If Shopify gives
an uncertain result, the worker stops writes for that shop. Inspect the exact
source and target in Shopify before making any correction.
