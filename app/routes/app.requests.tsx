import { randomUUID } from "node:crypto";
import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, isRouteErrorResponse, useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { indexingDate } from "../components/indexing-summary";
import { workbenchOwner } from "../services/product-workbench";
import { workbenchActionsEnabled } from "../services/product-workbench.server";
import { MAX_PRODUCT_SELECTION } from "../services/product-workbench.shared";
import { parseOwnedRequestFilters, readOwnedPendingRequests } from "../services/owned-requests";
import { exportPendingRequestPage } from "../services/product-workbench-export";
import type { action } from "./app.products";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!["GET", "HEAD"].includes(request.method)) throw new Response(null, { status: 405 });
  const { session, sessionToken } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  let filters;
  try { filters = parseOwnedRequestFilters(params); }
  catch { throw new Response("Invalid request filters", { status: 400 }); }
  const page = await readOwnedPendingRequests(prisma, session.shop, workbenchOwner(session.shop, sessionToken.sub), filters);
  if (params.get("format") === "csv") return new Response(request.method === "HEAD" ? null : exportPendingRequestPage(page.items), { headers: {
    "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="indexer-my-waiting-requests.csv"',
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
  return data({ ...page, q: filters.q, cursor: params.get("cursor"), requestKey: randomUUID(), actionsEnabled: workbenchActionsEnabled() }, { headers: { "Cache-Control": "private, no-store" } });
};

export default function OwnedRequests() {
  const { items, q, cursor, nextCursor, requestKey, actionsEnabled } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selection, setSelection] = useState<{ key: string; values: string[] }>({ key: requestKey, values: [] });
  const values = items.map((row) => `${row.id}~${new Date(row.updatedAt).toISOString()}`);
  const selected = (selection.key === requestKey ? selection.values : []).filter((value) => values.includes(value));
  const params = new URLSearchParams(q ? { q } : {});
  const firstHref = `/app/requests${params.size ? `?${params}` : ""}`;
  const csv = new URLSearchParams(params); if (cursor) csv.set("cursor", cursor); csv.set("format", "csv");
  const next = new URLSearchParams(params); if (nextCursor) next.set("cursor", nextCursor);
  const busy = fetcher.state !== "idle";
  return <s-page heading="My waiting requests">
    <s-section heading="Your internal work queue">
      <s-paragraph>Find your own waiting internal requests, including requests older than a product’s latest history. Claimed, retried and provider work is excluded. No worker is started here.</s-paragraph>
      <Form method="get" key={firstHref}>
        <label htmlFor="request-search">Product title, handle or Shopify product ID</label>
        <input id="request-search" name="q" defaultValue={q} maxLength={100} />
        <button type="submit">Find requests</button> <s-link href="/app/requests">Clear filters</s-link>
      </Form>
      <a href={`/app/requests?${csv}`} download>Download this page as CSV</a>
    </s-section>
    <s-section heading="Review and cancel waiting requests">
      {!actionsEnabled ? <s-paragraph>Queue actions are disabled. You can still review and export your requests.</s-paragraph> : null}
      <s-paragraph>Select up to 20 requests from this page. Cancellation is all-or-nothing: if any request changes or is claimed, refresh and review the selection again.</s-paragraph>
      {fetcher.data ? <p role="status">{fetcher.data.message}</p> : null}
      <fetcher.Form method="post" action="/app/products" key={requestKey} onSubmit={(event) => { if (!selected.length || !actionsEnabled || busy) event.preventDefault(); }}>
        <input type="hidden" name="intent" value="cancelMany" />
        {selected.map((value) => <input type="hidden" name="queue" value={value} key={value} />)}
        {items.length ? <s-table>
          <s-table-header-row><s-table-header listSlot="inline">Select</s-table-header><s-table-header listSlot="primary">Product</s-table-header><s-table-header listSlot="labeled">Requested</s-table-header><s-table-header listSlot="labeled">Request</s-table-header></s-table-header-row>
          <s-table-body>{items.map((row, index) => {
            const value = values[index]; const checked = selected.includes(value);
            return <s-table-row key={row.id}>
              <s-table-cell><input type="checkbox" aria-label={`Select request for ${row.title ?? row.gid}`} checked={checked} disabled={!actionsEnabled || busy || (!checked && selected.length >= MAX_PRODUCT_SELECTION)} onChange={(e) => setSelection({ key: requestKey, values: e.currentTarget.checked ? [...selected, value] : selected.filter((v) => v !== value) })} /></s-table-cell>
              <s-table-cell><s-link href={`/app/products/${encodeURIComponent(row.productId)}`}>{row.title ?? row.gid}</s-link><s-paragraph>{row.gid}</s-paragraph></s-table-cell>
              <s-table-cell>{indexingDate(row.createdAt)}</s-table-cell>
              <s-table-cell><s-link href={`/app/indexing/${encodeURIComponent(row.id)}`}>View request</s-link></s-table-cell>
            </s-table-row>;
          })}</s-table-body>
        </s-table> : <s-paragraph>No waiting requests match. Your requests may already be completed, claimed, retried or cancelled.</s-paragraph>}
        <p aria-live="polite">{selected.length} of {MAX_PRODUCT_SELECTION} selected.</p>
        <button type="submit" disabled={!actionsEnabled || busy || !selected.length}>Cancel {selected.length} selected requests</button>
        <button type="button" disabled={!actionsEnabled || busy || !items.length} onClick={() => setSelection({ key: requestKey, values: values.slice(0, MAX_PRODUCT_SELECTION) })}>Select up to 20 on this page</button>
        <button type="button" disabled={busy} onClick={() => setSelection({ key: requestKey, values: [] })}>Clear selection</button>
      </fetcher.Form>
      <s-stack direction="inline" gap="base"><s-link href={firstHref}>Newest matching requests</s-link>{nextCursor ? <s-link href={`/app/requests?${next}`}>Older requests</s-link> : null}<s-link href="/app/products">Product workspace</s-link></s-stack>
      <s-paragraph>Up to 25 requests per page. Searches and exports never cancel requests. Revalidation clears the selection.</s-paragraph>
    </s-section>
  </s-page>;
}

export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args)); result.set("Cache-Control", "private, no-store"); return result;
};

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && [401, 403].includes(error.status)) return boundary.error(error);
  return <s-page heading="My waiting requests"><s-section heading="Requests are unavailable"><s-paragraph>Check your filters or try again later. No requests were cancelled.</s-paragraph><s-link href="/app/requests">Return to my waiting requests</s-link></s-section></s-page>;
}
