import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import type { ScanRun } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { IndexingSummary } from "../components/indexing-summary";
import { readIndexingSummary } from "../services/indexing-dashboard";
import {
  cancelInitialScan,
  pauseInitialScan,
  resumeInitialScan,
  runNextBatch,
  startInitialScan,
} from "../services/initial-scan.server";

const scanSelect = {
  id: true, status: true, productsProcessed: true, productsIndexable: true,
  productsNonIndexable: true, productsChanged: true, queueItemsCreated: true,
  errorsCount: true, lastProgressAt: true,
} as const;

function scanSummary(scan: Pick<ScanRun, keyof typeof scanSelect>) {
  return {
    id: scan.id, status: scan.status, productsProcessed: scan.productsProcessed,
    productsIndexable: scan.productsIndexable, productsNonIndexable: scan.productsNonIndexable,
    productsChanged: scan.productsChanged, queueItemsCreated: scan.queueItemsCreated,
    errorsCount: scan.errorsCount, lastProgressAt: scan.lastProgressAt,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop }, select: { id: true } });
  if (!shop) return { counts: { tracked: 0, indexable: 0, pending: 0, failed: 0, events: 0 }, recentEvents: [], scan: null, indexing: null };
  const [tracked, indexable, indexing, events, recentEvents, scan] = await Promise.all([
    prisma.productIndexState.count({ where: { shopId: shop.id, deletedAt: null } }),
    prisma.productIndexState.count({ where: { shopId: shop.id, deletedAt: null, indexabilityState: "INDEXABLE" } }),
    readIndexingSummary(prisma, shop.id),
    prisma.indexEvent.count({ where: { shopId: shop.id } }),
    prisma.indexEvent.findMany({ where: { shopId: shop.id }, orderBy: { receivedAt: "desc" }, take: 8,
      select: { id: true, eventType: true, shopifyProductGid: true, meaningfulContentChanged: true, receivedAt: true } }),
    prisma.scanRun.findFirst({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, select: scanSelect }),
  ]);
  return { counts: { tracked, indexable, pending: indexing.counts.PENDING, failed: indexing.counts.FAILED, events }, recentEvents, scan: scan ? scanSummary(scan) : null, indexing };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const runId = String(formData.get("runId") ?? "");
  try {
    if (intent === "start") return { scan: scanSummary(await startInitialScan(session.shop)), error: null };
    if (!runId) return { scan: null, error: "A scan run is required." };
    if (intent === "continue") {
      const resumed = await resumeInitialScan(session.shop, runId);
      return { scan: scanSummary(await runNextBatch({ admin, shopDomain: session.shop, runId: resumed.id })), error: null };
    }
    if (intent === "pause") return { scan: scanSummary(await pauseInitialScan(session.shop, runId)), error: null };
    if (intent === "cancel") return { scan: scanSummary(await cancelInitialScan(session.shop, runId)), error: null };
    return { scan: null, error: "Unknown scan action." };
  } catch {
    console.error(JSON.stringify({ event: "initial_scan_action_failed", code: "SCAN_ACTION_FAILED" }));
    return { scan: null, error: "The scan could not be updated. Refresh its status before trying again." };
  }
};

function Metric({ label, value }: { label: string; value: number }) {
  return <s-box padding="base" borderWidth="base" borderRadius="base"><s-stack direction="block" gap="small-200"><s-text color="subdued">{label}</s-text><s-heading>{String(value)}</s-heading></s-stack></s-box>;
}

export default function Index() {
  const { counts, recentEvents, scan, indexing } = useLoaderData<typeof loader>();
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
        <s-paragraph>Tracks meaningful public product changes and prepares durable indexing work. Provider submission and search engine inclusion are separate outcomes.</s-paragraph>
        <s-stack direction="inline" gap="base">
          <Metric label="Tracked products" value={counts.tracked} /><Metric label="Indexable products" value={counts.indexable} />
          <Metric label="Pending queue" value={counts.pending} /><Metric label="Failed queue items" value={counts.failed} /><Metric label="Events recorded" value={counts.events} />
        </s-stack>
      </s-section>
      <s-section heading="Indexing overview">
        {indexing ? <IndexingSummary summary={indexing} /> : <s-paragraph>No indexing data has been recorded yet.</s-paragraph>}
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
            </s-box>
          ))}</s-stack>
        )}
      </s-section>
      <s-section slot="aside" heading="Integrations"><s-link href="/app/provider-settings">Review provider configuration</s-link><s-paragraph>Enabling a setting does not confirm worker execution or search engine inclusion.</s-paragraph></s-section>
      <s-section slot="aside" heading="Indexability"><s-paragraph>Product eligibility and provider submission are separate checks. Use SEO Audit to review storefront issues.</s-paragraph></s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  const result = new Headers(boundary.headers(headersArgs));
  result.set("Cache-Control", "private, no-store");
  return result;
};
