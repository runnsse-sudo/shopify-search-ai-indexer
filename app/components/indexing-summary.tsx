import type { readIndexingSummary } from "../services/indexing-dashboard";

export function indexingDate(value: Date | string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().replace("T", " ").slice(0, 19)} UTC` : "Not recorded";
}

export function IndexingSummary({ summary }: { summary: Awaited<ReturnType<typeof readIndexingSummary>> }) {
  return <s-stack direction="block" gap="base">
    <s-stack direction="inline" gap="base">
      <s-paragraph>Waiting jobs: {summary.counts.PENDING}</s-paragraph>
      <s-paragraph>Processing jobs: {summary.counts.PROCESSING}</s-paragraph>
      <s-paragraph>Failed jobs: {summary.counts.FAILED}</s-paragraph>
      <s-paragraph>Waiting product events: {summary.webhooks.waiting}</s-paragraph>
      <s-paragraph>Processing product events: {summary.webhooks.processing}</s-paragraph>
      <s-paragraph>Failed product events: {summary.webhooks.failed}</s-paragraph>
    </s-stack>
    {summary.counts.FAILED + summary.webhooks.failed > 0 ? <s-banner tone="warning" heading="Some work needs attention">
      Review failed jobs and product events before taking further action. Opening this page does not retry them.
    </s-banner> : null}
    <s-paragraph>IndexNow setting: {!summary.indexNow.configured ? "Not configured" : summary.indexNow.enabled ? "Enabled" : "Disabled"}.
      {summary.indexNow.ownershipVerifiedAt ? ` Ownership last verified: ${indexingDate(summary.indexNow.ownershipVerifiedAt)}.` : " Ownership has not been verified."}
      {" "}This setting alone does not prove that a worker is running or that a product appears in search results.
    </s-paragraph>
    <s-stack direction="inline" gap="base">
      <s-link href="/app/indexing">View indexing jobs</s-link>
      <s-link href="/app/provider-settings">Review IndexNow settings</s-link>
    </s-stack>
  </s-stack>;
}
