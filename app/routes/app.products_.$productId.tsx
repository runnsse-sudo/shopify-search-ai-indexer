import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { indexingDate } from "../components/indexing-summary";
import { parseProductFilters, readProducts, workbenchOwner } from "../services/product-workbench";
import { workbenchActionsEnabled, workbenchFailure } from "../services/product-workbench.server";
import type { action } from "./app.products";
export { ErrorBoundary } from "./app.products";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  if (!["GET", "HEAD"].includes(request.method)) throw new Response(null, { status: 405 });
  const { session, sessionToken } = await authenticate.admin(request);
  if (!params.productId) throw new Response(null, { status: 404 });
  try {
    const result = await readProducts(prisma, session.shop, workbenchOwner(session.shop, sessionToken.sub), parseProductFilters(new URLSearchParams()), params.productId);
    return data({ product: result.items[0], actionsEnabled: workbenchActionsEnabled() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { throw new Response(null, { status: workbenchFailure(e).status }); }
};

export default function ProductDetail() {
  const { product: p, actionsEnabled } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  return <s-page heading={p.title ?? p.gid}>
    <s-section heading="Recorded product status">
      <s-paragraph>{p.gid} · {p.state} · {p.productStatus ?? "Unknown"}</s-paragraph>
      <s-paragraph>{p.deleted ? "Deletion recorded" : p.published ? "Publication recorded" : "Publication unverified"}. Last recorded indexing: {indexingDate(p.lastIndexedAt)}.</s-paragraph>
      <s-paragraph>{p.eligible ? "Eligible for internal preparation from the product workspace." : "Not currently eligible for internal preparation."} Eligibility is rechecked when submitting. Search engine inclusion is unverified.</s-paragraph>
      <s-link href="/app/products">Return to product workspace</s-link>
    </s-section>
    <s-section heading="Recent indexing requests">
      <s-paragraph>Up to 10 latest requests. Open a request for its recorded attempt history. Only your untouched, waiting internal requests can be cancelled; processing and provider work cannot be cancelled here.</s-paragraph>
      {fetcher.data ? <p role="status">{fetcher.data.message}</p> : null}
      {p.jobs.length ? p.jobs.map((q) => <s-box key={q.id} padding="base" borderWidth="base">
        <s-link href={`/app/indexing/${encodeURIComponent(q.id)}`}>{q.provider} / {q.action} / {q.status}</s-link><s-paragraph>{q.diagnostic}</s-paragraph>
        {actionsEnabled && q.cancellable ? <fetcher.Form method="post" action="/app/products">
          <input type="hidden" name="intent" value="cancel" /><input type="hidden" name="queueId" value={q.id} /><input type="hidden" name="updatedAt" value={new Date(q.updatedAt).toISOString()} />
          <button type="submit" disabled={fetcher.state !== "idle"}>Cancel my waiting internal request</button>
        </fetcher.Form> : null}
      </s-box>) : <s-paragraph>No indexing request has been recorded.</s-paragraph>}
    </s-section>
  </s-page>;
}
export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args)); result.set("Cache-Control", "private, no-store"); return result;
};
