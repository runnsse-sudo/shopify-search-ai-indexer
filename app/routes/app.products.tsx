import { randomUUID } from "node:crypto";
import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, isRouteErrorResponse, useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { indexingDate } from "../components/indexing-summary";
import { parseProductFilters, readProducts, readWorkbenchCommand, WorkbenchError, workbenchOwner } from "../services/product-workbench";
import { MAX_PRODUCT_SELECTION, PRODUCT_STATES } from "../services/product-workbench.shared";
import { executeWorkbenchCommand, workbenchActionsEnabled, workbenchFailure } from "../services/product-workbench.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!["GET", "HEAD"].includes(request.method)) throw new Response(null, { status: 405 });
  const { session, sessionToken } = await authenticate.admin(request);
  let filters;
  try { filters = parseProductFilters(new URL(request.url).searchParams); }
  catch { throw new Response("Invalid product filters", { status: 400 }); }
  return data({ ...await readProducts(prisma, session.shop, workbenchOwner(session.shop, sessionToken.sub), filters),
    filters: { q: filters.q, state: filters.state }, requestKey: randomUUID(), actionsEnabled: workbenchActionsEnabled(),
  }, { headers: { "Cache-Control": "private, no-store" } });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") throw new Response(null, { status: 405 });
  const { session, sessionToken } = await authenticate.admin(request);
  try {
    // Check both here and at the transaction boundary; disabled requests never read a body or DB.
    if (!workbenchActionsEnabled()) throw new WorkbenchError("ACTIONS_DISABLED", 403);
    const command = await readWorkbenchCommand(request);
    const result = await executeWorkbenchCommand(prisma, session.shop, workbenchOwner(session.shop, sessionToken.sub), command);
    return data({ ok: true as const, result, message: command.intent === "cancel" ? "Your waiting internal request was cancelled." : `${result.created} internal requests prepared; ${result.skipped} already requested or active. No worker was started.` }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const { status, message } = workbenchFailure(error);
    return data({ ok: false as const, result: null, message }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
};

export default function Products() {
  const { items, nextCursor, filters, requestKey, actionsEnabled } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState<{ key: string; values: string[] }>({ key: requestKey, values: [] });
  // Stale entries from another page or a revalidated loader are excluded automatically.
  const visible = (selected.key === requestKey ? selected.values : []).filter((value) => items.some((p) => p.eligible && `${p.id}~${new Date(p.updatedAt).toISOString()}` === value));
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.state) params.set("state", filters.state);
  const firstHref = `/app/products${params.size ? `?${params}` : ""}`;
  if (nextCursor) params.set("cursor", nextCursor);
  return <s-page heading="Product workspace">
    <s-section heading="Recorded products">
      <s-paragraph>Review stored product eligibility, queue history and provider outcomes. This page does not fetch Shopify products or start a worker. Search engine inclusion is unverified.</s-paragraph>
      <Form method="get" key={firstHref}>
        <label htmlFor="product-search">Title, handle or Shopify product ID</label>
        <input id="product-search" name="q" maxLength={100} defaultValue={filters.q} />
        <label htmlFor="product-state">Recorded eligibility</label>
        <select id="product-state" name="state" defaultValue={filters.state}><option value="">All states</option>{PRODUCT_STATES.map((s) => <option key={s}>{s}</option>)}</select>
        <button type="submit">Find products</button> <s-link href="/app/products">Clear filters</s-link>
      </Form>
    </s-section>
    <s-section heading="Select products for internal preparation">
      <s-paragraph>{actionsEnabled ? "Only active, published, indexable products with a verified same-domain canonical URL can be selected. Existing active work is preserved." : "Queue actions are disabled. Separate operational approval is required before enabling them."}</s-paragraph>
      {fetcher.data ? <p role="status">{fetcher.data.message}</p> : null}
      <fetcher.Form method="post" key={requestKey} onSubmit={(event) => { if (!visible.length || fetcher.state !== "idle") event.preventDefault(); }}>
        <input type="hidden" name="intent" value="enqueue" /><input type="hidden" name="requestKey" value={requestKey} />
        {visible.map((value) => <input type="hidden" name="product" value={value} key={value} />)}
        {items.length ? <s-table>
          <s-table-header-row><s-table-header listSlot="inline">Select</s-table-header><s-table-header listSlot="primary">Product</s-table-header><s-table-header listSlot="labeled">Eligibility</s-table-header><s-table-header listSlot="labeled">Indexing status</s-table-header></s-table-header-row>
          <s-table-body>{items.map((p) => {
            const value = `${p.id}~${new Date(p.updatedAt).toISOString()}`; const checked = visible.includes(value); const job = p.jobs[0];
            return <s-table-row key={p.id}>
              <s-table-cell><input aria-label={`Select ${p.title ?? p.gid}`} type="checkbox" checked={checked} disabled={!actionsEnabled || !p.eligible || fetcher.state !== "idle" || (!checked && visible.length >= MAX_PRODUCT_SELECTION)} onChange={(e) => setSelected({ key: requestKey, values: e.currentTarget.checked ? [...visible, value] : visible.filter((s) => s !== value) })} /></s-table-cell>
              <s-table-cell><s-link href={`/app/products/${encodeURIComponent(p.id)}`}>{p.title ?? p.gid}</s-link><s-paragraph>{p.gid}</s-paragraph></s-table-cell>
              <s-table-cell>{p.state} · {p.productStatus ?? "Unknown"}<s-paragraph>{p.eligible ? "Eligible for internal preparation" : "Not currently eligible"}</s-paragraph></s-table-cell>
              <s-table-cell>{job ? <><s-link href={`/app/indexing/${encodeURIComponent(job.id)}`}>{job.provider} / {job.status}</s-link><s-paragraph>{job.diagnostic}</s-paragraph></> : "No job recorded"}<s-paragraph>Last recorded indexing: {indexingDate(p.lastIndexedAt)}</s-paragraph></s-table-cell>
            </s-table-row>;
          })}</s-table-body>
        </s-table> : <s-paragraph>No recorded products match these filters.</s-paragraph>}
        <p aria-live="polite">{visible.length} of 20 selected. Only INTERNAL requests will be created.</p>
        <button type="submit" disabled={!actionsEnabled || !visible.length || fetcher.state !== "idle"}>Prepare {visible.length} internal requests</button>
        <button type="button" onClick={() => setSelected({ key: requestKey, values: [] })}>Clear selection</button>
      </fetcher.Form>
      <s-stack direction="inline" gap="base"><s-link href={firstHref}>Newest matching products</s-link>{nextCursor ? <s-link href={`/app/products?${params}`}>Older products</s-link> : null}<s-link href="/app/indexing">Queue overview</s-link></s-stack>
      <s-paragraph>Up to 25 products per page. Refreshing provides a new selection; re-submitting the same request does not create duplicates.</s-paragraph>
    </s-section>
  </s-page>;
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && [401, 403].includes(error.status)) return boundary.error(error);
  return <s-page heading="Product workspace"><s-section heading="Products are unavailable"><s-paragraph>Check your filters or try again later. No worker was started.</s-paragraph><s-link href="/app/products">Return to products</s-link></s-section></s-page>;
}
export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args)); result.set("Cache-Control", "private, no-store"); return result;
};
