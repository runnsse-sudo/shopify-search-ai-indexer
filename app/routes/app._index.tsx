import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { counts: { tracked: 0, indexable: 0, pending: 0, failed: 0, events: 0 }, recentEvents: [] };
  const [tracked, indexable, pending, failed, events, recentEvents] = await Promise.all([
    prisma.productIndexState.count({ where: { shopId: shop.id, deletedAt: null } }),
    prisma.productIndexState.count({ where: { shopId: shop.id, deletedAt: null, indexabilityState: "INDEXABLE" } }),
    prisma.indexQueueItem.count({ where: { shopId: shop.id, status: "PENDING" } }),
    prisma.indexQueueItem.count({ where: { shopId: shop.id, status: "FAILED" } }),
    prisma.indexEvent.count({ where: { shopId: shop.id } }),
    prisma.indexEvent.findMany({ where: { shopId: shop.id }, orderBy: { receivedAt: "desc" }, take: 8,
      select: { id: true, eventType: true, meaningfulContentChanged: true, receivedAt: true, error: true } }),
  ]);
  return { counts: { tracked, indexable, pending, failed, events }, recentEvents };
};

function Metric({ label, value }: { label: string; value: number }) {
  return <s-box padding="base" borderWidth="base" borderRadius="base"><s-stack direction="block" gap="small-200"><s-text color="subdued">{label}</s-text><s-heading>{String(value)}</s-heading></s-stack></s-box>;
}

export default function Index() {
  const { counts, recentEvents } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Runn Search AI Indexer">
      <s-section heading="Search & AI Indexing">
        <s-paragraph>Tracks meaningful public product changes and prepares durable internal indexing work. No external indexing providers are called in Phase 1.</s-paragraph>
        <s-stack direction="inline" gap="base">
          <Metric label="Tracked products" value={counts.tracked} /><Metric label="Indexable products" value={counts.indexable} />
          <Metric label="Pending queue" value={counts.pending} /><Metric label="Failed queue items" value={counts.failed} /><Metric label="Events recorded" value={counts.events} />
        </s-stack>
      </s-section>
      <s-section heading="Phase 1 status">
        <s-unordered-list>
          <s-list-item>Product create, update, and delete webhooks configured</s-list-item>
          <s-list-item>Deterministic fingerprints gate indexing queue work</s-list-item>
          <s-list-item>Resumable product scan service ready for a controlled trigger</s-list-item>
          <s-list-item>Google, Bing, IndexNow, and AI audit providers: Not configured</s-list-item>
        </s-unordered-list>
      </s-section>
      <s-section heading="Recent events">
        {recentEvents.length === 0 ? <s-paragraph>No product events have been recorded yet.</s-paragraph> : (
          <s-stack direction="block" gap="small-300">{recentEvents.map((event) => (
            <s-box key={event.id} padding="small-300" borderWidth="base" borderRadius="base">
              <s-paragraph>{event.eventType} · {event.meaningfulContentChanged ? "meaningful change" : "no fingerprint change"} · {new Date(event.receivedAt).toLocaleString()}</s-paragraph>
              {event.error ? <s-text>Processing error recorded</s-text> : null}
            </s-box>
          ))}</s-stack>
        )}
      </s-section>
      <s-section slot="aside" heading="Integrations"><s-paragraph>External indexing providers are deliberately not configured.</s-paragraph></s-section>
      <s-section slot="aside" heading="Indexability"><s-paragraph>Phase 1 requires active status and a valid Shopify Online Store URL. Deeper storefront checks are deferred.</s-paragraph></s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
