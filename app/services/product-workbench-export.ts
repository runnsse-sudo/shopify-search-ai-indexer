import { PRODUCT_PAGE_SIZE } from "./product-workbench.shared.ts";

type ExportProduct = {
  gid: string; title: string | null; handle: string | null; state: string;
  productStatus: string | null; eligible: boolean; eligibilityReason: string | null;
  lastIndexedAt: Date | string | null;
  jobs: { provider: string; status: string }[];
};

// CSV is a bounded copy of the visible page, never a raw database export.
// Neutralize spreadsheet formulas even after leading whitespace/control characters.
function cell(value: unknown) {
  let text = [...String(value ?? "").slice(0, 512)].map((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char).join("");
  if (/^\s*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportProductPage(items: ExportProduct[]) {
  if (items.length > PRODUCT_PAGE_SIZE) throw new Error("EXPORT_PAGE_LIMIT");
  const rows: unknown[][] = [["Shopify product ID", "Title", "Handle", "Recorded eligibility", "Product status", "Eligible for preparation", "Eligibility reason", "Latest request provider", "Latest request status", "Last recorded indexing"]];
  for (const p of items) rows.push([
    p.gid, p.title, p.handle, p.state, p.productStatus, p.eligible ? "Yes" : "No", p.eligibilityReason,
    p.jobs[0]?.provider, p.jobs[0]?.status,
    p.lastIndexedAt ? new Date(p.lastIndexedAt).toISOString() : "",
  ]);
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
