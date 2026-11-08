import assert from "node:assert/strict";
import test from "node:test";
import { generatePublicLlmCatalog, prepareLlmStorefrontFiles, isPublicProductPath } from "../app/services/llm-visibility/llm-catalog.server.ts";

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

test("prepares three stable root targets and hashes only changed content", () => {
  const catalog = { count: 1, text: "# shop.example\n" };
  const before = prepareLlmStorefrontFiles("shop.example", catalog);
  assert.deepEqual(before, prepareLlmStorefrontFiles("shop.example", catalog));
  assert.deepEqual(before.files.map(file => file.target), [
    "https://shop.example/agents.md",
    "https://shop.example/llms.txt",
    "https://shop.example/llms-full.txt",
  ]);
  const after = prepareLlmStorefrontFiles("shop.example", { count: 2, text: catalog.text + "More\n" });
  assert.deepEqual(after.files.filter((file, index) => file.sha256 !== before.files[index].sha256)
    .map(file => file.name), ["llms-full.txt"]);
});

for (const handle of ["kos%C2%AE-par-puca%C2%AE", "dropduo%c2%ae", "caf%C3%A9", "%E6%97%A5%E6%9C%AC", "one%5Ftwo%2Dthree"]) {
  test(`strict export preserves valid percent-encoded handle: ${handle}`, async () => {
    assert.equal(isPublicProductPath(`/products/${handle}`), true);
    const result = await generatePublicLlmCatalog({ graphql: async () => page([product(1, handle)]) }, "shop.example", true);
    assert.equal(result.count, 1);
    assert.ok(result.text.includes(`https://shop.example/products/${handle})`));
  });
}

for (const handle of ["bad%", "bad%GG", "bad%C2", "bad%C0%AF", "bad%ED%A0%80", "a%2fb", "a%5Cb", "%2e%2e", "a/%2E%2E/b", "a%252Fb", "a%25b", "a%00b", "a%0Ab", "a%20b", "a%7Fb", "a%E2%80%AEb", "a%28b", "a%3Cb", "a%3Fb", "a%23b"]) {
  test(`strict export rejects unsafe or invalid escape without returning a partial catalogue: ${handle}`, async () => {
    assert.equal(isPublicProductPath(`/products/${handle}`), false);
    await assert.rejects(generatePublicLlmCatalog({ graphql: async () => page([product(1, "valid"), product(2, handle)]) }, "shop.example", true), /CATALOG_URL_MISMATCH/);
  });
}

test("encoded handles never bypass origin, credentials, product path, locale or duplicates", async () => {
  for (const url of ["https://other.example/products/kos%C2%AE", "http://shop.example/products/kos%C2%AE", "https://user:password@shop.example/products/kos%C2%AE", "https://shop.example:444/products/kos%C2%AE", "https://shop.example/pages/kos%C2%AE", "https://shop.example/products/kos%C2%AE/extra", "https://shop.example/sv%2Fproducts/kos%C2%AE"]) {
    await assert.rejects(generatePublicLlmCatalog({graphql: async () => page([{...product(1, "unused"), onlineStoreUrl:url}])},"shop.example",true),/CATALOG_URL_MISMATCH/);
  }
  const url="https://shop.example/sv-se/products/kos%C2%AE/";
  const result=await generatePublicLlmCatalog({graphql:async()=>page([{...product(1,"unused"),onlineStoreUrl:url}])},"shop.example",true);
  assert.ok(result.text.includes("https://shop.example/sv-se/products/kos%C2%AE)"));
  await assert.rejects(generatePublicLlmCatalog({graphql:async()=>page([product(1,"kos%C2%AE"),product(2,"kos%C2%AE")])},"shop.example",true),/CATALOG_DUPLICATE_URL/);
});

test("raw Unicode Shopify handles become valid encoded URLs without relaxing validation", async () => {
  const result = await generatePublicLlmCatalog({graphql:async()=>page([product(1,"kos\u00ae-puca\u00ae")])},"shop.example",true);
  assert.ok(result.text.includes("/products/kos%C2%AE-puca%C2%AE)"));
});
