# Indexing visibility and diagnostics

## Existing capabilities and this change

| Area | Existing implementation | Delivered here / remaining limits |
| --- | --- | --- |
| Automatic product indexing | Durable create/update/delete intake, fingerprint and publication checks, initial scan, provider materialization and separately enabled workers | Shows unfinished product events and indexing jobs. Does not enable or run workers. |
| Queue management | Pending-intent deduplication, claims, ownership checks, cancellation/supersession and lease recovery | Shop-scoped, filtered queue history with bounded keyset pages and job details. No retry/cancel controls added. |
| Errors and retries | Durable webhook error classes, bounded attempts/backoff, claim fencing and provider attempts | Safe error-class explanations, retry schedule/budget and paginated attempt history. Raw errors/provider bodies are excluded. |
| IndexNow | Ownership/configuration checks, encrypted per-shop credentials, executor and multishop controls | Reports enabled/ownership metadata without fetching credentials. Settings do not prove active execution. |
| Status/dashboard | Product/event counters, initial scan UI; obsolete static Phase 1/provider text | Shared live database overview on Home and Indexing jobs, provider backlog and attention indicators. |
| Diagnostics | Worker logs and attempt rows, but no merchant queue/attempt view | Bounded read-only authenticated routes, safe HTTP-result explanations and sanitized scan-action failures. |
| Performance/cost | Existing indexes, fingerprints, dedupe, provider and worker caps | Grouped counts, no per-row application query loop, no offset pagination or automatic polling, no new dependencies/resources/migrations. |

No new provider integrations or full search-engine inclusion verification are introduced.
Google product push and AI auditing remain distinct from the existing IndexNow path.

## Views

- `/app/indexing`: overview, optional exact provider/status/product filter, newest matching jobs first, older pages, latest recorded attempt per job, and the ten latest unfinished/failed webhooks.
- `/app/indexing/:queueId`: owned job metadata and twenty recorded attempts per page, descending by attempt number.
- Home: reuses the grouped overview instead of claiming all external providers are unconfigured. Existing scan controls remain; their responses/logs no longer disclose raw exceptions or scan claim/error fields.

Queue status `COMPLETED` means queue processing completed. `INTERNAL` is preparation;
it is not proof of a provider request. IndexNow HTTP 200/202 indicate request handling,
not search-engine inclusion. Missing or contradictory attempt results require review.
No UI control changes `REVIEW_REQUIRED` or the separate production activation decision.

## Read boundaries and cost

Every lookup derives the shop from the existing authenticated session. Queue, attempt,
webhook and grouped-count reads carry that shop ID. A missing/foreign detail returns 404.
Invalid filters/positions return 400; the new routes have no action and reject POST.
Shopify authentication boundaries/headers are retained; responses are private/no-store.

The overview uses two grouped counts and one provider-metadata read. The list requests
at most 26 queue rows (25 plus a continuation sentinel), one latest attempt per row,
and eleven webhook rows (10 plus a sentinel). Prisma may issue a separate batched
relation query for attempts; there is no application-level per-row query loop.
Detail pages request at most 21 attempts. Ties in queue creation time use descending ID,
and cursors preserve filters and tenant scope. Newer inserts do not shift older pages.
Counts and rows are separate reads, not an atomic audit snapshot; the UI says so.

Only explicit metadata fields are selected. No `Session`, encrypted provider credential,
`lastError`, `responseBody`, attempt `error`, queue URL or claim-token field is read for
these views. Unknown webhook classes become generic messages. Raw provider messages
are not used as customer-facing guidance. Fixed labels and React escaping are retained.

Existing indexes are reused. Bounded returned rows do not guarantee constant database
work for grouped counts or sorting large shops; production query-plan measurements
may be appropriate before large-scale use. No monthly service-cost change is proposed.

## Validation and release boundaries

`npm run test:pure` discovers the two new suites. They cover tenant isolation, strict
filters, tied timestamp keyset traversal, page caps, safe metadata projection, HTTP
diagnostics, actual authenticated route loaders and server-rendered error/empty/data
states. Database/auth/scan seams in route tests are synthetic; network is disabled by
the existing pure-test isolation helper. These tests do not contact Shopify or PostgreSQL.

Also run the existing typecheck, lint and app build before review. A live embedded
browser session, actual PostgreSQL query plans and hosted CI remain separate evidence.
Do not call `npm run setup`, workers, migrations, workflow dispatch or deployment to
validate these read-only views without their separate approvals.

This change does not modify Prisma schema, workers, drain/Observer packages, credentials,
baselines or activation gates. At the last verified production review the SQL baseline
was v77 and live settingsVersion v78; the cause was UNKNOWN and `REVIEW_REQUIRED` remained.
That historical observation must be refreshed for any future production operation.
Local uncommitted changes also mean old exact-clean-worktree execution certificates
cannot be treated as current authorization. Commit/publication and production remain
separately approved operations.

Protocol/UI references: [IndexNow response semantics](https://www.indexnow.org/documentation)
and [Shopify App Home](https://shopify.dev/docs/apps/build/app-home).
