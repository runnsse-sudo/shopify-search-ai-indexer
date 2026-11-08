# Six-store catalogue setup — local, read-only

The catalogue setup section is available only for the six existing CATALOG_SHOPS.
It is explicitly triggered by the merchant and uses the authenticated session's
shop, never a client-supplied shop or file ID. It reads Shopify shop identity,
primary domain and this app's scopes. It only lists catalogue file candidates
when read_files or write_files is already granted. It never asks for scopes,
creates or updates a file, touches storage or invokes a worker.

The file permission button is now shown for exactly the six approved shops.
It calls the existing Robotto scope-request logic through a shop-allowlisted
wrapper, only on an explicit merchant click. The original helper remains
unchanged: request only write_files when missing, then re-query the actual grant;
a claimed success response alone cannot establish permission. Preparation and
page loading never call the permission request. Unknown shops stop before any
scope lookup. Local tests use synthetic scopes clients; no real consent was
requested or granted during development. Downloading a setup report grants no
permission. This extension was explicitly approved after the earlier narrower
approval review; previous rejection/evidence reports remain historical.

The setup report is PREPARATION_ONLY with activation.ready=false even when an
existing file is READY. It never invents a file ID, theme ID or successful
backup. Active theme, existing template bytes/ownership, immutable backups,
offline session, scoped storage IAM, costs and the separate pilot/activation
mandate remain required. Missing file access is not evidence of an absent file.
Multiple candidates, additional pages, mismatched identities, unsafe CDN URLs,
provider errors and changed Robotto bindings cannot become publication targets.
Errors returned to the UI never include provider bodies or credentials.

Initial publication drafts for all six shops are in six-store-initial-catalogs.json.
The five new shops require independently approved first-file provisioning. Theme
IDs and body hashes remain explicitly unverified, so these drafts are not
runnable instructions. Preserve Shopify-managed /agents.md and /llms.txt. Only
own, exactly identified new artifacts could be removed during a separately
approved rollback; an existing file/template requires verified previous bytes
and SHA256 and concurrency checks before replacement or restoration.

The current Shopify CDN partitions may contain two or three four-digit groups.
The previous shared validator only accepted two, rejecting Robotto's actual
/s/files/1/0766/2777/1738/files/llms-full.txt. Both legitimate shapes are now
accepted; arbitrary depths, other filenames and hosts remain rejected. Robotto's
known file ID and exact partition are independently pinned by setup inspection.

## Storage proposal, not applied

six-store-catalog-iam-proposal.json reuses the existing two custom roles and
preserves existing bindings. The lock role (objects.create/get/delete) is proposed
only for the other five exact publication.lock objects and all six exact
daily-state.json objects. CAS overwrite of a state object needs create/delete.
The backup role (objects.create/get) is proposed only for the other five exact
backup prefixes and .txt objects. It grants no bucket-wide list or backup delete.
Fresh policy/etag and role comparison, inherited/deny assessment and separate
explicit IAM approval are mandatory before application. No role is changed here.

## Bounded future run and cost proposal — not active or approved

Use the existing built image/worker, never npm run setup or a migrating startup.
Proposed future job: one task, parallelism 1, 1 vCPU, 512 MiB, maxRetries 0,
30 minute timeout, processing six enabled verified targets sequentially. A new
job or scheduler would require explicit approval; none exists for this worker in
the qualified europe-north2 job list. A supported scheduler region must be
qualified: europe-north2 is absent from the observed Cloud Scheduler locations.
No scheduler or IAM grant is created by this document.

At these proposed bounds each attempted execution allocates up to 1,800 vCPU
seconds and 900 GiB seconds plus provider lifecycle overhead. Price those units
using verified europe-north2 job rates before any cost admission; they are not a
hard invoice ceiling. Separate GCS requests, immutable backup growth, logging,
network, tax and currency effects. Per-run and monthly total cost remains UNKNOWN
until those inputs and an approved run frequency are fixed. No free-tier quota is
assumed. Cloud Scheduler's published list price is USD 0.10/job/month beyond its
free allowance; account allowance remains UNKNOWN. Sources read 2026-11-08:
https://cloud.google.com/run/pricing and https://cloud.google.com/scheduler/pricing.

The existing 24-hour gate measures time since completion. A fixed once-daily
schedule can skip a day if today's run starts less than 24 hours after yesterday's
completion. Keep this behavior visible; choose cadence explicitly before daily
activation and do not silently weaken the 24-hour gate in this setup package.
No guaranteed daily freshness, current prices or stock are claimed by this link
catalogue.
