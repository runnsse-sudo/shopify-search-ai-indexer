import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  cancelInitialScan,
  pauseInitialScan,
  resumeInitialScan,
  runNextBatch,
  startInitialScan,
} from "../services/initial-scan.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { counts: { tracked: 0, indexable: 0, pending: 0, failed: 0, events: 0 }, recentEvents: [], scan: null };
  const [tracked, indexable, pending, failed, events, recentEvents, scan] = await Promise.all([
    prisma.productIndexState.count({ where: { shopId: shop.id, deletedAt: null } }),
    prisma.productIndexState.count({ where: { shopId: shop.id, deletedAt: null, indexabilityState: "INDEXABLE" } }),
    prisma.indexQueueItem.count({ where: { shopId: shop.id, status: "PENDING" } }),
    prisma.indexQueueItem.count({ where: { shopId: shop.id, status: "FAILED" } }),
    prisma.indexEvent.count({ where: { shopId: shop.id } }),
    prisma.indexEvent.findMany({ where: { shopId: shop.id }, orderBy: { receivedAt: "desc" }, take: 8,
      select: { id: true, eventType: true, shopifyProductGid: true, meaningfulContentChanged: true, receivedAt: true, error: true } }),
    prisma.scanRun.findFirst({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } }),
  ]);
  return { counts: { tracked, indexable, pending, failed, events }, recentEvents, scan };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const runId = String(formData.get("runId") ?? "");
  try {
    if (intent === "start") return { scan: await startInitialScan(session.shop), error: null };
    if (!runId) return { scan: null, error: "A scan run is required." };
    if (intent === "continue") {
      const resumed = await resumeInitialScan(session.shop, runId);
      return { scan: await runNextBatch({ admin, shopDomain: session.shop, runId: resumed.id }), error: null };
    }
    if (intent === "pause") return { scan: await pauseInitialScan(session.shop, runId), error: null };
    if (intent === "cancel") return { scan: await cancelInitialScan(session.shop, runId), error: null };
    return { scan: null, error: "Unknown scan action." };
  } catch (error) {
    console.error("Initial scan action failed", { shop: session.shop, intent, runId, error });
    return { scan: null, error: error instanceof Error ? error.message : "Initial scan action failed." };
  }
};

function Metric({ label, value }: { label: string; value: number }) {
  return <s-box padding="base" borderWidth="base" borderRadius="base"><s-stack direction="block" gap="small-200"><s-text color="subdued">{label}</s-text><s-heading>{String(value)}</s-heading></s-stack></s-box>;
}

export default function Index() {
  const { counts, recentEvents, scan } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const displayedScan = fetcher.data?.scan ?? scan;
  const busy = fetcher.state !== "idle";
  const canStart = !displayedScan || ["COMPLETED", "CANCELLED"].includes(displayedScan.status);
  const canContinue = displayedScan && ["PENDING", "RUNNING", "PAUSED", "FAILED"].includes(displayedScan.status);
  const canPause = displayedScan && ["PENDING", "RUNNING"].includes(displayedScan.status);
  const canCancel = displayedScan && !["COMPLETED", "CANCELLED"].includes(displayedScan.status);
  const submitScanAction = (intent: string) => fetcher.submit(
    { intent, ...(displayedScan ? { runId: displayedScan.id } : {}) },
    { method: "POST" },
  );
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
      <s-section heading="Initial catalog scan">
        {displayedScan ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>Status: {displayedScan.status}</s-paragraph>
            <s-unordered-list>
              <s-list-item>Products processed: {displayedScan.productsProcessed}</s-list-item>
              <s-list-item>Indexable: {displayedScan.productsIndexable}</s-list-item>
              <s-list-item>Non-indexable: {displayedScan.productsNonIndexable}</s-list-item>
              <s-list-item>Meaningful changes: {displayedScan.productsChanged}</s-list-item>
              <s-list-item>Queue jobs created: {displayedScan.queueItemsCreated}</s-list-item>
              <s-list-item>Errors: {displayedScan.errorsCount}</s-list-item>
            </s-unordered-list>
            <s-paragraph>Last progress: {displayedScan.lastProgressAt ? new Date(displayedScan.lastProgressAt).toLocaleString() : "Not started"}</s-paragraph>
          </s-stack>
        ) : <s-paragraph>No initial catalog scan has been started.</s-paragraph>}
        {fetcher.data?.error ? <s-paragraph>{fetcher.data.error}</s-paragraph> : null}
        <s-stack direction="inline" gap="base">
          {canStart ? <s-button onClick={() => submitScanAction("start")} {...(busy ? { loading: true } : {})}>Start initial scan</s-button> : null}
          {canContinue ? <s-button onClick={() => submitScanAction("continue")} {...(busy ? { loading: true } : {})}>{["PAUSED", "FAILED"].includes(displayedScan.status) ? "Resume" : "Continue next batch"}</s-button> : null}
          {canPause ? <s-button variant="secondary" onClick={() => submitScanAction("pause")}>Pause</s-button> : null}
          {canCancel ? <s-button variant="secondary" onClick={() => submitScanAction("cancel")}>Cancel</s-button> : null}
        </s-stack>
      </s-section>
      <s-section heading="Recent events">
        {recentEvents.length === 0 ? <s-paragraph>No product events have been recorded yet.</s-paragraph> : (
          <s-stack direction="block" gap="small-300">{recentEvents.map((event) => (
            <s-box key={event.id} padding="small-300" borderWidth="base" borderRadius="base">
              <s-paragraph>{event.shopifyProductGid} · {event.eventType} · {event.meaningfulContentChanged ? "meaningful change" : "no fingerprint change"} · {new Date(event.receivedAt).toLocaleString()}</s-paragraph>
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
