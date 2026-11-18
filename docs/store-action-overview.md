# Store activity and actions

The app home reads only the authenticated store's persisted catalog and redirect results. It starts no audits or publications. Attention cards appear first and link to the existing feature pages. The LLM page also shows the ten latest catalog attempts.

The overview shows the latest meaningful catalog attempt, last successful verification, safe stop code, and a SHA256 comparison against the previous recorded successful attempt when available. NOT_DUE attempts remain in catalog history but do not count as fresh verification. No historical catalog results are invented or imported from logs.

Redirect summaries use the latest two runs, their recorded creation counts, and up to five target issues with a total issue count. Target checks are historical observations. A successful run with zero creations does not establish complete coverage of every storefront URL. Existing audit details describe coverage.

Results older than 36 hours need attention. Unfinished runs older than two hours need review. Missing or unreadable history is unknown, and a failure reading one subsystem does not mask the other. Opening the page requires no GCP or additional Shopify permissions.

## Release order

Apply the additive `20261118120000_add_catalog_refresh_history` migration before releasing the web and catalog worker images. Update the web and existing multishop catalog worker through their separately approved release process. Preserve existing worker arguments, environment, schedules, lock, backup and rollback configuration. No redirect worker update is needed for this package.

The catalog worker registers an attempt before entering the existing publisher and records its allowlisted result after it returns. A failure to register prevents publication. A failure to save the final result fails the attempt without retrying publication. A worker killed mid-run leaves RUNNING evidence for review. Candidate-only executions do not become live catalog history. Existing catalog verification, exclusion, backup and rollback behavior remains in the publisher.

For rollback, restore the previous images and retain the additive table and its evidence. Previous workers continue to function but do not write catalog history. Confirm store isolation, the home cards, catalog history, and a normal scheduled result in the authenticated app before declaring the feature live.

## Local validation on 18 November 2026

- All 784 network-isolated pure tests passed, including rendered overview, route authentication, tenant isolation, failure handling and the actual worker fixture.
- The PostgreSQL integration passed against an isolated local PostgreSQL 17 database. All migrations applied, catalog outcomes persisted, and overview reads stayed scoped to each store. The test server was stopped afterward.
- Prisma validation and generation, application typecheck, lint, web build, and multishop catalog worker packaging passed.
- The standalone Shopify App Home validator could not validate the UI because its Preact JSX environment does not expose the Polaris elements used by this React app. Its three validation attempts failed on that environment. The app's installed React/Polaris declarations and rendered markup tests passed. Standalone toolkit validation remains unverified.
- Production migration, hosted authenticated UI checks and scheduled recording with the new worker remain release-stage checks.
