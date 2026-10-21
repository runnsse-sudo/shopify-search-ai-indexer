import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { IndexingSummary, indexingDate } from "../components/indexing-summary";
import { parseQueueFilters, QUEUE_PROVIDERS, QUEUE_STATUSES, queueHref, readIndexingDashboard } from "../services/indexing-dashboard";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET" && request.method !== "HEAD") throw new Response(null, { status: 405 });
  const { session } = await authenticate.admin(request);
  let filters;
  try { filters = parseQueueFilters(new URL(request.url).searchParams); }
  catch { throw new Response("Invalid indexing filters", { status: 400 }); }
  return data({ ...await readIndexingDashboard(prisma, session.shop, filters),
    filters: { status: filters.status, provider: filters.provider, product: filters.product },
    firstPageHref: queueHref(filters),
  }, { headers: { "Cache-Control": "private, no-store" } });
};

export default function IndexingJobs() {
  const { summary, items, filters, nextCursor, firstPageHref, webhooks, moreWebhooks, observedAt } = useLoaderData<typeof loader>();
  return <s-page heading="Indexing jobs">
    <s-section heading="Current overview">
      {summary ? <IndexingSummary summary={summary} /> : <s-paragraph>No indexing data has been recorded for this shop.</s-paragraph>}
      <s-paragraph>Observed: {indexingDate(observedAt)}. Counts cover this shop across all providers; the list below follows your filters. Work may change while you browse.</s-paragraph>
      <s-paragraph>A completed internal job prepares work for a provider. Even provider acceptance does not confirm search engine inclusion.</s-paragraph>
    </s-section>
    <s-section heading="Find jobs">
      <Form method="get" key={firstPageHref}>
        <s-stack direction="block" gap="base">
          <label htmlFor="queue-status">Queue status</label>
          <select id="queue-status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">All statuses</option>
            {QUEUE_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <label htmlFor="queue-provider">Provider</label>
          <select id="queue-provider" name="provider" defaultValue={filters.provider ?? ""}>
            <option value="">All providers</option>
            {QUEUE_PROVIDERS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <label htmlFor="queue-product">Product ID</label>
          <input id="queue-product" name="product" defaultValue={filters.product} maxLength={60} placeholder="123456789 or gid://shopify/Product/123456789" />
          <s-stack direction="inline" gap="base"><button type="submit">Apply filters</button><s-link href="/app/indexing">Clear filters</s-link></s-stack>
        </s-stack>
      </Form>
    </s-section>
    <s-section heading="Queue history">
      {items.length === 0 ? <s-paragraph>No jobs match these filters.</s-paragraph> : <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Product / job</s-table-header>
          <s-table-header listSlot="labeled">Provider / action</s-table-header>
          <s-table-header listSlot="labeled">Queue status</s-table-header>
          <s-table-header listSlot="labeled">Schedule / latest attempt</s-table-header>
        </s-table-header-row>
        <s-table-body>{items.map((item) => <s-table-row key={item.id}>
          <s-table-cell><s-link href={`/app/indexing/${encodeURIComponent(item.id)}`}>{item.shopifyProductGid}</s-link><s-paragraph>{item.id}</s-paragraph></s-table-cell>
          <s-table-cell>{item.provider} / {item.action}</s-table-cell>
          <s-table-cell>{item.status}<s-paragraph>{item.outcome}</s-paragraph></s-table-cell>
          <s-table-cell>
            <s-paragraph>{item.schedule}</s-paragraph>
            {item.status === "PENDING" ? <s-paragraph>Scheduled: {indexingDate(item.nextAttemptAt)}</s-paragraph> : null}
            <s-paragraph>{item.latestAttempt?.diagnostic ?? "No attempt recorded. Provider submission is unverified."}</s-paragraph>
          </s-table-cell>
        </s-table-row>)}</s-table-body>
      </s-table>}
      <s-stack direction="inline" gap="base">
        <s-link href={firstPageHref}>Newest matching jobs</s-link>
        {nextCursor ? <s-link href={`${firstPageHref}${firstPageHref.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(nextCursor)}`}>Older jobs</s-link> : null}
      </s-stack>
      <s-paragraph>Up to 25 jobs per page. Open a job to inspect its recorded attempts.</s-paragraph>
    </s-section>
    <s-section heading="Product events needing attention">
      <s-paragraph>These events have not finished processing. They are separate from indexing jobs and are shown across all product filters.</s-paragraph>
      {webhooks.length === 0 ? <s-paragraph>No unfinished or failed product events were found.</s-paragraph> : <s-stack direction="block" gap="base">
        {webhooks.map((event) => <s-box key={event.id} padding="base" borderWidth="base" borderRadius="base">
          <s-paragraph>{event.product ?? "Product not recorded"} · {event.topic} · {event.status}</s-paragraph>
          <s-paragraph>Processing attempts: {event.attemptCount}. Received: {indexingDate(event.receivedAt)}.</s-paragraph>
          <s-paragraph>{event.diagnostic}</s-paragraph>
          {event.status === "PENDING" || event.status === "RETRY" ? <s-paragraph>Next scheduled attempt: {indexingDate(event.nextAttemptAt)}</s-paragraph> : null}
        </s-box>)}
      </s-stack>}
      {moreWebhooks ? <s-paragraph>Showing the 10 most recent unfinished or failed events. Additional events are included in the overview counts.</s-paragraph> : null}
    </s-section>
    {summary ? <s-section heading="Waiting work by provider">
      <s-unordered-list>{summary.providers.map((provider) => <s-list-item key={provider.provider}>{provider.provider}: {provider.pending} waiting, {provider.failed} failed</s-list-item>)}</s-unordered-list>
    </s-section> : null}
  </s-page>;
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && (error.status === 401 || error.status === 403)) return boundary.error(error);
  return <s-page heading="Indexing jobs"><s-section heading={isRouteErrorResponse(error) && error.status === 400 ? "Check the filters" : "Indexing status is unavailable"}>
    <s-paragraph>{isRouteErrorResponse(error) && error.status === 400 ? "Choose a listed provider and status, a valid product ID, or restart from the newest page." : "Try again later. No job was started or retried."}</s-paragraph>
    <s-link href="/app/indexing">Return to newest jobs</s-link>
  </s-section></s-page>;
}

export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args));
  result.set("Cache-Control", "private, no-store");
  return result;
};
