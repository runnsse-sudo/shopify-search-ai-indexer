# Public fetch and provider lifecycle safety

Provider readiness requires an offline Session for the exact shop domain and
the existing enabled, verified, credential and domain checks. Session existence
is an installation prerequisite, not proof that a Shopify token is currently valid.
No token is read or refreshed for this check.

The authenticated uninstall webhook atomically disables IndexNow, revokes
ownership verification, cancels that tenant's INDEXNOW PENDING/PROCESSING items
and deletes its Sessions, even when authentication returns no Session object.
INTERNAL intents and historical events/attempts remain. Queue cancellation clears
claim/dedupe fields so an old worker cannot complete or retry the cancelled claim.
An already-started external request cannot be recalled.

Selectors and materialization check the installation prerequisite. Every claimed
IndexNow item must pass a fresh scoped lifecycle check immediately before provider
invocation, after the pre-invocation callback. A revoked/missing installation is
terminally rejected without HTTP or IndexAttempt. A DB error also prevents HTTP.
There is no atomic transaction spanning the database and an external provider;
the guard does not claim to recall a request authorized before concurrent revocation.

Recreating a Session on reinstall does not restore disabled/verified provider
state. Verification and enabling require deliberate action. Late verification
and enable writes use the original config version and an installation check in
a Serializable transaction, preventing old responses from undoing uninstall.
Legacy single-shop workers now also require persisted provider readiness.

Public fetches use HTTPS, exact merchant hostname, no credentials/IP literal or
non-default port, manual redirects and public DNS answers before every request.
All returned DNS answers must pass IPv4/IPv6 policy, including mapped IPv4.
DNS prevalidation does **not** pin the native fetch connection; rebinding remains
transport hardening. Cross-host/scheme/port redirects are rejected before fetch.
Same-host ownership CDN redirects remain allowed after the initial root-key URL
is validated; the final bounded body must match the configured key.

Per-request deadlines cover DNS, headers and complete streamed/decompressed body.
Retries and hops remain separately bounded. Redirect/retry bodies are cancelled.
Content-Length is only an early rejection hint. Limits: ownership1KiB/10s/5redirects,
SEO5MiB default (maximum20MiB)/15s default/5redirects and existing bounded retries,
sitemap XML20MiB/15s/5redirects/one retry. Ownership errors are fixed safe codes,
never raw URLs, keys, DNS addresses or response text.

`npm run test:pure` discovers sorted `tests/*.test.mjs`, excludes DB integration,
removes the inherited DB connection and blocks real fetch/DNS/socket connections.
Fixtures must inject resolvers/network. CI runs this command. Compilation fixtures
may write only to ignored build-tests outputs; no production connection is used.
Phase G renderer provisioning, scan/SEO claim fencing and rollout remain separate.
