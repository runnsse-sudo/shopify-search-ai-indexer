import assert from "node:assert/strict";
import test from "node:test";
import { generatePublicLlmCatalog } from "../app/services/llm-visibility/llm-catalog.server.ts";

const page = (nodes, hasNextPage = false) =>
  Response.json({ data: { products: { nodes, pageInfo: { hasNextPage } } } });
const product = (id, handle, status = "ACTIVE") => ({
  legacyResourceId: String(id),
  title: "Product [name]\nExtra",
  status,
  onlineStoreUrl: handle === null ? null : `https://shop.example/products/${handle}`,
});

test("walks every page and exports only deduplicated public product URLs", async () => {
  const filters = [];
  const admin = { graphql: async (_, { variables }) => {
    filters.push(variables.filter);
    return filters.length === 1
      ? page([product(1, "b"), product(2, null), product(3, "draft", "DRAFT")], true)
      : page([product(4, "a?tracking=1"), product(5, "b")]);
  } };
  const result = await generatePublicLlmCatalog(admin, "shop.example");
  assert.deepEqual(filters, [
    "status:active published_status:published id:>0",
    "status:active published_status:published id:>3",
  ]);
  assert.equal(result.count, 2);
  assert.match(result.text, /products\/a\).*\n.*products\/b\)/);
  assert.doesNotMatch(result.text, /tracking|draft/);
});

test("fails closed for foreign origins and incomplete pagination", async () => {
  const foreign = { ...product(1, "a"), onlineStoreUrl: "https://other.example/products/a" };
  await assert.rejects(generatePublicLlmCatalog({ graphql: async () => page([foreign]) }, "shop.example"),
    /CATALOG_URL_MISMATCH/);
  await assert.rejects(generatePublicLlmCatalog({ graphql: async () => page([product(1, "a")], true) },
    "shop.example"), /CATALOG_CURSOR_INVALID/);
  await assert.rejects(generatePublicLlmCatalog({ graphql: async () => Response.json({ errors: [{}] }) },
    "shop.example"), /CATALOG_READ_FAILED/);
});
