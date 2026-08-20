# Runn Search AI Indexer

Runn Search AI Indexer detects meaningful changes to Shopify products and stores an auditable, provider-ready indexing queue. Phase 1 is read-only for catalog data and makes no external search or AI provider calls.

## Phase 1 architecture

- Product create/update/delete webhooks authenticate through the Shopify React Router adapter.
- Current product data comes from Admin GraphQL rather than incomplete webhook payloads.
- A normalized SHA-256 fingerprint covers public product, SEO, variant, and media fields; only changed fingerprints create index work.
- Prisma stores shops, product state, events, queue items, and future provider attempts.
- The internal queue supports claiming, completion, retry/backoff, failure, cancellation, and index/deindex actions.
- `scanProductPage` is a cursor-based controlled initial-scan foundation. It is never run automatically and has no UI trigger yet.
- The dashboard shows real per-shop database counts and recent events.

Product fetches currently cap each product at 100 variants and 50 media items. Basic indexability requires active status and a valid Shopify `onlineStoreUrl`; `publishedAt` is diagnostic only. Shopify's primary domain is retained for candidate URLs, while the last known `onlineStoreUrl` is preserved for deindexing. HTTP, canonical, robots, sitemap, agents.md, llms.txt, structured-data, and full publication-channel audits are not yet implemented.

Google, Bing, IndexNow, OpenAI, Gemini, Perplexity, and other provider calls are deliberately not implemented. Existing Shopify agents/LLM infrastructure remains unchanged.

## Phase 2 initial catalog scan

The dashboard provides an explicit, request-driven initial scan. Each Continue or Resume action processes at most 25 products through Shopify Admin GraphQL cursor pagination, then persists the cursor and exact counters. Runs can be paused, resumed after restart or failure, and cancelled without removing collected product state. A short database-backed batch lease prevents overlapping requests from processing the same cursor.

Products record the scan run that most recently saw them. This provides the foundation for future missing-product reconciliation, but Phase 2 deliberately does not infer deletion or enqueue removal solely from a missing marker. No scan runs automatically during startup, installation, authentication, or migration.

## Cloud Run catalog scan worker

The same production image includes a standalone worker invoked with `npm run scan-worker`. It never creates a scan: it resumes an existing `PENDING`, `RUNNING`, or `FAILED` run using the stored Shopify offline session and checkpoints progress in PostgreSQL after every Shopify page. Run one Cloud Run task per logical catalog scan. Dashboard pause and cancel actions are observed between batches, and external indexing providers are not called.

Optional worker environment variables are `SCAN_RUN_ID`, `SCAN_SHOP_DOMAIN`, `SCAN_BATCH_SIZE` (default 100), `SCAN_MAX_BATCHES` (default 1000), and `SCAN_INTER_BATCH_DELAY_MS` (default 500). `SCAN_RUN_ID` is the strongest selector. Without either selector, the worker proceeds only when exactly one eligible scan exists.

To repair product-level errors from one completed initial scan, run the same image with `REPAIR_SCAN_RUN_ID` set and invoke `npm run repair-scan-errors`. The repair worker selects only failed `INITIAL_SCAN` events for that shop whose timestamps fall between the run's `startedAt` and `completedAt`, deduplicates product IDs, and processes them sequentially as `MANUAL_SCAN` events. Historical events do not contain a direct scan-run foreign key, so this timestamp window is intentionally conservative; review the structured summary before treating it as a complete historical attribution.

Queue identity is one `PENDING` intent per shop, product, provider, and action. Its reason and URL describe the latest desired intent and are compacted into that pending slot. `PROCESSING` and terminal rows have no dedupe key, so one processing request and one newer pending successor may legitimately coexist. Audit queue integrity using `duplicatePendingIntentGroups`, `processingWithDedupeKey`, `pendingWithoutDedupeKey`, and `terminalWithDedupeKey` rather than treating all processing-plus-pending combinations as duplicates.

`PROCESSING` queue rows use their non-null `claimedAt` timestamp as the ownership token for that processing attempt. Completion and failure must present the exact token; delayed workers lose ownership without mutating a later claim. Expired processing leases are recovered explicitly in bounded batches, either returning work to its pending slot or skipping it when a newer pending successor exists. A future executor should create `IndexAttempt` audit rows only for actual owned provider invocations and use the model's per-queue-item unique attempt number; this phase creates no attempts. This lease hardening is in place before provider execution; all external providers remain disabled.

Provider fan-out planning is now defined by a pure capability registry, but it is not wired to queue writes or execution. `INTERNAL` remains the source intent only. A valid HTTPS URL plans `INDEXNOW` by default for both index and deindex; explicitly enabled `BING` may additionally receive index work but not deindex work. `GOOGLE` is reserved for a future Search Console, sitemap, or audit strategy and is never treated as product push. `AI_AUDIT` is likewise not an external indexing target. Unsupported choices are returned as deterministic skipped reasons. No provider credentials, API calls, provider workers, or `IndexAttempt` rows are introduced by this planning layer.

The one-time INTERNAL queue reconciliation runs with `npm run reconcile-queue`. Set `QUEUE_RECONCILE_SHOP_DOMAIN`; it is a dry-run unless `QUEUE_RECONCILE_APPLY=true` exactly. APPLY aborts if any INTERNAL queue item for that shop is processing. It cancels older duplicate pending rows, preserves the newest URL/reason, and then normalizes each keeper's pending-intent key without deleting history.

Production rollout order is strict: deploy the new enqueue semantics while provider execution remains disabled; do not enable consumers; run reconciliation dry-run and verify the old-key/duplicate plan; run APPLY; run dry-run again and require zero effective mutations; run the queue invariant audit; only then may provider implementation or execution proceed. Never reconcile first and leave the old reason-key service running, because it can recreate old-key pending rows after normalization.

## Development and database

PostgreSQL is the required persistent database for development, staging, and production. Set `DATABASE_URL` to a PostgreSQL connection string; copy `.env.example` as a safe starting point and never commit real credentials.

```sh
npm install
npx prisma migrate dev
npx prisma generate
npm run dev
```

Use `npx prisma migrate deploy` in deployed environments; the existing `npm run setup` and Docker startup already use this production-safe command. SQLite was used only during pre-production development, and no production data migration was required when the migration history was replaced with the PostgreSQL baseline. Validation commands are `npx prisma format`, `npx prisma validate`, `npm run typecheck`, `npm run lint`, and `npm run build`.

# Shopify App Template - React Router

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using [React Router](https://reactrouter.com/). It was forked from the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) and converted to React Router.

Rather than cloning this repo, follow the [Quick Start steps](https://github.com/Shopify/shopify-app-template-react-router#quick-start).

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-react-router) for more details on the React Router app package.

## Upgrading from Remix

If you have an existing Remix app that you want to upgrade to React Router, please follow the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Otherwise, please follow the quick start guide below.

## Quick start

### Prerequisites

Before you begin, you'll need to [download and install the Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started) if you haven't already.

### Setup

```shell
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router
```

### Local Development

```shell
shopify app dev
```

Press P to open the URL to your app. Once you click install, you can start development.

Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes pre-configured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks. Please see [/app/routes/webhooks.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/webhooks.app.uninstalled.tsx).
4. Using metafields, metaobjects, and declarative custom data definitions. Please see [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx) and [shopify.app.toml](https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml).

Please read the [documentation for @shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router) to see what other API's are available.

## Shopify Dev MCP

This template is configured with the Shopify Dev MCP. This instructs [Cursor](https://cursor.com/), [GitHub Copilot](https://github.com/features/copilot) and [Claude Code](https://claude.com/product/claude-code) and [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) to use the Shopify Dev MCP.

For more information on the Shopify Dev MCP please read [the documentation](https://shopify.dev/docs/apps/build/devmcp).

## Deployment

### Application Storage

This application uses [Prisma](https://www.prisma.io/) with PostgreSQL for Shopify sessions and all indexing state. A valid `DATABASE_URL` is required. Deployments apply the committed PostgreSQL migration history with `prisma migrate deploy`.

SQLite was development-only before the first production deployment; no production data migration was required. PostgreSQL is now the required database provider.
Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Build the app by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/launch/deployment) to host it externally. From there, you have a few options:

- [Google Cloud Run](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run): This tutorial is written specifically for this example repo, and is compatible with the extended steps included in the subsequent [**Build your app**](tutorial) in the **Getting started** docs. It is the most detailed tutorial for taking a React Router-based Shopify app and deploying it to production. It includes configuring permissions and secrets, setting up a production database, and even hosting your apps behind a load balancer across multiple regions.
- [Fly.io](https://fly.io/docs/js/shopify/): Leverages the Fly.io CLI to quickly launch Shopify apps to a single machine.
- [Render](https://render.com/docs/deploy-shopify-app): This tutorial guides you through using Docker to deploy and install apps on a Dev store.
- [Manual deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service): This resource provides general guidance on the requirements of deployment including environment variables, secrets, and persistent data.

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Gotchas / Troubleshooting

### Database tables don't exist

If you get an error like:

```
The table `main.Session` does not exist in the current database.
```

Create the database for Prisma. Run the `setup` script in `package.json` using `npm`, `yarn` or `pnpm`.

### Navigating/redirecting breaks an embedded app

Embedded apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `react-router` or `@shopify/polaris`. Do not use `<a>`.
2. Use `redirect` returned from `authenticate.admin`. Do not use `redirect` from `react-router`
3. Use `useSubmit` from `react-router`.

This only applies if your app is embedded, which it will be by default.

### Webhooks: shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.

Instead of using the `afterAuth` hook declare app-specific webhooks in the `shopify.app.toml` file. This approach is easier since Shopify will automatically sync changes every time you run `deploy` (e.g: `npm run deploy`). Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?deliveryMethod=https)

If you do need shop-specific webhooks, keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, uninstall and reinstall the app. Revisiting the app will call the `afterAuth` hook.

### Webhooks: Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.

The recommended solution is to use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead. Test your webhooks by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Webhooks: Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app. This is expected.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

If so, please update [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/.graphqlrc.ts).

### Using Defer & await for streaming responses

By default the CLI uses a cloudflare tunnel. Unfortunately cloudflare tunnels wait for the Response stream to finish, then sends one chunk. This will not affect production.

To test [streaming using await](https://reactrouter.com/api/components/Await#await) during local development we recommend [localhost based development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options#localhost-based-development).

### "nbf" claim timestamp check failed

This is because a JWT token is expired. If you are consistently getting this error, it could be that the clock on your machine is not in sync with the server. To fix this ensure you have enabled "Set time and date automatically" in the "Date and Time" settings on your computer.

### Using MongoDB and Prisma

If you choose to use MongoDB with Prisma, there are some gotchas in Prisma's MongoDB support to be aware of. Please see the [Prisma SessionStorage README](https://www.npmjs.com/package/@shopify/shopify-app-session-storage-prisma#mongodb).

### Unable to require(`C:\...\query_engine-windows.dll.node`).

Unable to require(`C:\...\query_engine-windows.dll.node`).
The Prisma engines do not seem to be compatible with your system.

query_engine-windows.dll.node is not a valid Win32 application.

**Fix:** Set the environment variable:

```shell
PRISMA_CLIENT_ENGINE_TYPE=binary
```

This forces Prisma to use the binary engine mode, which runs the query engine as a separate process and can work via emulation on Windows ARM64.

## Resources

React Router:

- [React Router docs](https://reactrouter.com/home)

Shopify:

- [Intro to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [Shopify App React Router docs](https://shopify.dev/docs/api/shopify-app-react-router)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify App Bridge](https://shopify.dev/docs/api/app-bridge-library).
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components).
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)

Internationalization:

- [Internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)
