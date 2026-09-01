import assert from "node:assert/strict";

import {
  fetchStorefrontPage,
} from "../build-tests/seo-storefront-fetch.mjs";

const originalFetch =
  globalThis.fetch;

const productUrl =
  "https://example.com/products/example";

function htmlResponse(
  status,
  body = "<html><body>Example</body></html>",
  headers = {},
) {
  return new Response(
    body,
    {
      status,
      headers,
    },
  );
}

try {
  {
    let calls = 0;

    globalThis.fetch =
      async () => {
        calls += 1;

        if (calls === 1) {
          return htmlResponse(503);
        }

        return htmlResponse(
          200,
          "<html><body>Recovered</body></html>",
        );
      };

    const result =
      await fetchStorefrontPage({
        url: productUrl,
        allowedHost:
          "example.com",
        retryBaseDelayMs: 0,
      });

    assert.equal(
      result.statusCode,
      200,
    );

    assert.equal(
      calls,
      2,
    );
  }

  {
    let calls = 0;

    globalThis.fetch =
      async () => {
        calls += 1;
        return htmlResponse(503);
      };

    const result =
      await fetchStorefrontPage({
        url: productUrl,
        allowedHost:
          "example.com",
        retryBaseDelayMs: 0,
      });

    assert.equal(
      result.statusCode,
      503,
    );

    assert.equal(
      calls,
      3,
    );
  }

  {
    let calls = 0;

    globalThis.fetch =
      async () => {
        calls += 1;
        return htmlResponse(404);
      };

    const result =
      await fetchStorefrontPage({
        url: productUrl,
        allowedHost:
          "example.com",
        retryBaseDelayMs: 0,
      });

    assert.equal(
      result.statusCode,
      404,
    );

    assert.equal(
      calls,
      1,
    );
  }

  {
    let calls = 0;

    globalThis.fetch =
      async () => {
        calls += 1;

        if (calls === 1) {
          throw new Error(
            "temporary network error",
          );
        }

        return htmlResponse(200);
      };

    const result =
      await fetchStorefrontPage({
        url: productUrl,
        allowedHost:
          "example.com",
        retryBaseDelayMs: 0,
      });

    assert.equal(
      result.statusCode,
      200,
    );

    assert.equal(
      calls,
      2,
    );
  }

  {
    let calls = 0;

    globalThis.fetch =
      async () => {
        calls += 1;

        if (calls === 1) {
          return htmlResponse(429);
        }

        return htmlResponse(200);
      };

    const result =
      await fetchStorefrontPage({
        url: productUrl,
        allowedHost:
          "example.com",
        retryBaseDelayMs: 0,
      });

    assert.equal(
      result.statusCode,
      200,
    );

    assert.equal(
      calls,
      2,
    );
  }

  {
    let calls = 0;

    globalThis.fetch =
      async (input) => {
        calls += 1;

        const url =
          input instanceof URL
            ? input.toString()
            : String(input);

        if (
          url === productUrl
        ) {
          return htmlResponse(
            302,
            "",
            {
              location:
                "/products/final",
            },
          );
        }

        return htmlResponse(200);
      };

    const result =
      await fetchStorefrontPage({
        url: productUrl,
        allowedHost:
          "example.com",
        retryBaseDelayMs: 0,
      });

    assert.equal(
      result.statusCode,
      200,
    );

    assert.equal(
      result.finalUrl,
      "https://example.com/products/final",
    );

    assert.deepEqual(
      result.redirectChain,
      [
        "https://example.com/products/final",
      ],
    );

    assert.equal(
      calls,
      2,
    );
  }

  console.log(
    "SEO_AUDIT_STOREFRONT_RETRY_VERIFY=PASS",
  );
} finally {
  globalThis.fetch =
    originalFetch;
}
