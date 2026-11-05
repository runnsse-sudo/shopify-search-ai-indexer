import type { LlmVisibilityAuditResult } from "./llm-visibility.server";

export async function validateLlmAuditRequest(request: Request, appUrl: string | undefined) {
  // The server-side request URL may use HTTP after TLS termination.
  const publicUrl = appUrl ? URL.parse(appUrl) : null;
  if (
    request.method !== "POST" ||
    !publicUrl ||
    !["http:", "https:"].includes(publicUrl.protocol) ||
    request.headers.get("origin") !== publicUrl.origin
  ) {
    throw new Response("Request not permitted", { status: 403 });
  }
  if ((request.headers.get("content-type") ?? "").split(";",1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") throw new Response("Unsupported form", {status:415});
  const reader=request.body?.getReader();let raw="",size=0;const decoder=new TextDecoder();
  if(reader)try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();throw new Response("Form too large",{status:413});}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}
  const params=new URLSearchParams(raw);
  if(params.getAll("intent").length!==1 || params.get("intent")!=="run-read-only" || [...params.keys()].some(key=>key!=="intent")) throw new Response("Invalid audit request",{status:400});
}

export function llmDownload(content: string, kind: "text" | "json" = "text") {
  return `data:${kind === "json" ? "application/json" : "text/plain"};charset=utf-8,${encodeURIComponent(content)}`;
}

export function llmReport(result: LlmVisibilityAuditResult, observedAt: string) {
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("INVALID_AUDIT_TIME");
  return JSON.stringify({
    version: 1, observedAt, primaryHost: result.primaryHost,
    scope: "Technical readiness from a bounded sample; not AI mentions, ranking or guaranteed inclusion.",
    score: result.score, scoreLabel: result.scoreLabel, scoreNote: result.scoreNote,
    robots: result.robots, agentsMd: result.agentsMd, llmsTxt: result.llmsTxt, llmsFullTxt: result.llmsFullTxt,
    crawlers: result.crawlers, aiAccessSummary: result.aiAccessSummary,
    sitemap: result.sitemap, recommendations: result.recommendations,
    mode: "AUDIT_ONLY", contentStrategy: "SHOPIFY_MANAGED_BASE",
    discoveryGuidance: {
      canonicalShopifyPath: "/agents.md",
      compatibilityPaths: ["/llms.txt", "/llms-full.txt"],
      identicalContentIsExpected: true,
      catalogEligibility: "NOT_VERIFIED",
      catalogNote: "Shopify Catalog is a separate product feed. Review eligibility and product data mapping in Shopify admin.",
      searchNote: "Discovery files do not guarantee AI mentions or rankings. Google AI features do not require special AI text files.",
      sources: ["https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/products", "https://llmstxt.org/", "https://developers.google.com/search/docs/appearance/ai-features"],
    },
    customTemplateOwnership: "NOT_VERIFIED", writesPerformed: 0, timings: result.timings,
  }, null, 2) + "\n";
}
