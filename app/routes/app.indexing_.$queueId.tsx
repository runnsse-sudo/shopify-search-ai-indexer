import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { indexingDate } from "../components/indexing-summary";
import { parseAttemptBefore, readIndexingDetail } from "../services/indexing-dashboard";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  if (request.method !== "GET" && request.method !== "HEAD") throw new Response(null, { status: 405 });
  const { session } = await authenticate.admin(request);
  let before;
  try { before = parseAttemptBefore(new URL(request.url).searchParams); }
  catch { throw new Response("Invalid attempt position", { status: 400 }); }
  const detail = await readIndexingDetail(prisma, session.shop, params.queueId ?? "", before);
  if (!detail) throw new Response("Job not found", { status: 404 });
  return data(detail, { headers: { "Cache-Control": "private, no-store" } });
};

export default function IndexingJob() {
  const { item, attempts, nextBefore, observedAt } = useLoaderData<typeof loader>();
  return <s-page heading="Indexing job details">
    <s-section heading="Job status">
      <s-link href="/app/indexing">Back to indexing jobs</s-link>
      <s-paragraph>Product: {item.shopifyProductGid}</s-paragraph>
      <s-paragraph>Job: {item.id}</s-paragraph>
      <s-paragraph>{item.provider} / {item.action} / {item.status}</s-paragraph>
      <s-paragraph>{item.outcome ?? item.schedule}</s-paragraph>
      <s-paragraph>Recorded retry count: {item.retryCount} / {item.maxRetries}</s-paragraph>
      <s-paragraph>Created: {indexingDate(item.createdAt)}. Updated: {indexingDate(item.updatedAt)}.</s-paragraph>
      <s-paragraph>Next scheduled attempt: {indexingDate(item.nextAttemptAt)}. Claim started: {indexingDate(item.claimedAt)}. Completed: {indexingDate(item.completedAt)}.</s-paragraph>
      <s-paragraph>Observed: {indexingDate(observedAt)}. This page shows records and does not run or retry work.</s-paragraph>
    </s-section>
    <s-section heading="Recorded attempts">
      <s-paragraph>Provider responses describe request handling. They do not prove that a product is indexed or appears in search results.</s-paragraph>
      {attempts.length === 0 ? <s-paragraph>No attempts found on this page. This does not establish provider submission.</s-paragraph> : <s-stack direction="block" gap="base">
        {attempts.map((attempt) => <s-box key={attempt.id} padding="base" borderWidth="base" borderRadius="base">
          <s-heading>Attempt {attempt.attemptNumber}</s-heading>
          <s-paragraph>{attempt.provider} · Recorded result: {attempt.successful ? "successful" : "not successful"} · HTTP response: {attempt.responseCode ?? "not recorded"}</s-paragraph>
          <s-paragraph>{attempt.diagnostic}</s-paragraph>
          <s-paragraph>Started: {indexingDate(attempt.startedAt)}. Completed: {indexingDate(attempt.completedAt)}.</s-paragraph>
        </s-box>)}
      </s-stack>}
      <s-stack direction="inline" gap="base">
        <s-link href={`/app/indexing/${encodeURIComponent(item.id)}`}>Latest attempts</s-link>
        {nextBefore !== null ? <s-link href={`/app/indexing/${encodeURIComponent(item.id)}?before=${nextBefore}`}>Older attempts</s-link> : null}
      </s-stack>
      <s-paragraph>Up to 20 attempts per page. Stored provider bodies and raw error messages are not displayed.</s-paragraph>
    </s-section>
  </s-page>;
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && (error.status === 401 || error.status === 403)) return boundary.error(error);
  const heading = isRouteErrorResponse(error) && error.status === 404 ? "Job not found" : isRouteErrorResponse(error) && error.status === 400 ? "Invalid attempt page" : "Attempt history is unavailable";
  return <s-page heading={heading}><s-section><s-paragraph>Return to the job list or try again later. No work was started or retried.</s-paragraph><s-link href="/app/indexing">Indexing jobs</s-link></s-section></s-page>;
}

export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args));
  result.set("Cache-Control", "private, no-store");
  return result;
};
