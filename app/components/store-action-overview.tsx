import type { ActionCard, readStoreActionOverview } from "../services/store-action-overview";

type Overview = Awaited<ReturnType<typeof readStoreActionOverview>>;
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "Not recorded";

function StatusCard({ card }: { card: ActionCard }) {
  return <s-section heading={card.title}>
    <s-paragraph>{card.state === "attention" ? "Needs attention" : card.state === "current" ? "Up to date" : "Awaiting evidence"} · {card.status}</s-paragraph>
    <s-paragraph>{card.message}</s-paragraph>
    <s-paragraph>Latest run started: {time(card.observedAt)}</s-paragraph>
    <s-paragraph>Last successful verification: {time(card.lastSuccessAt)}</s-paragraph>
    {card.reason && <s-paragraph>Stop reason: {card.reason}</s-paragraph>}
    {card.change && <s-paragraph>{card.change}</s-paragraph>}
    <s-link href={card.href}>Review {card.title}</s-link>
  </s-section>;
}

export function StoreActionOverview({ overview }: { overview: Overview }) {
  const cards = [overview.catalog, overview.redirects.summary];
  const attention = cards.filter((card) => card.state === "attention").length;
  const unknown = cards.filter((card) => card.state === "unknown").length;
  return <>
    <s-section heading="Store activity & actions">
      <s-paragraph>{overview.shopDomain}</s-paragraph>
      <s-paragraph>{attention} areas need attention · {unknown} awaiting evidence</s-paragraph>
      <s-paragraph>Recorded results as of {time(overview.observedAt)}. Scheduled status and target checks reflect the last recorded observation.</s-paragraph>
    </s-section>
    {cards.sort((a, b) => Number(b.state === "attention") - Number(a.state === "attention")).map((card) => <StatusCard key={card.href} card={card} />)}
    {overview.redirects.issues.length > 0 && <s-section heading="Redirect targets needing attention">
      <s-paragraph>Showing {overview.redirects.issues.length} of {overview.redirects.issueCount} recorded issues.</s-paragraph>
      <s-unordered-list>{overview.redirects.issues.map((issue) => <s-list-item key={issue.shopifyId}>
        {issue.source} → {issue.target} · {issue.targetStatus === "NOT_FOUND" ? "Target returned 404" : "Target redirects onward"} · Checked {time(issue.checkedAt?.toISOString() ?? null)} · {issue.shopifyId}
      </s-list-item>)}</s-unordered-list>
      <s-link href="/app/redirect-audit">Review redirect history and target checks</s-link>
    </s-section>}
  </>;
}
