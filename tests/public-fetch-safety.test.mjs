import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchPublicText,
  isPublicAddress,
  sanitizeOwnershipError,
} from "../app/services/public-fetch.ts";
import { fetchIndexNowOwnershipFile } from "../app/services/indexnow-shop-config.ts";
import { fetchStorefrontPage } from "../app/services/seo-audit/storefront-fetch.server.ts";

const host = "store.myshopify.com";
const key = "synthetic-test-key";
const keyLocation = `https://${host}/${key}.txt`;
const ownership = { key, keyLocation, allowedHost: host };
const policy = {
  url: keyLocation,
  allowedHost: host,
  timeoutMs: 30,
  maxRedirects: 5,
  maxBodyBytes: 1024,
};
const publicDns = async () => [{ address: "93.184.216.34" }];
const redirect = (location) =>
  new Response("", { status: 302, headers: { location } });
function network(fetchImpl, resolve = publicDns) {
  return { fetchImpl, resolve };
}

test("ordinary public Shopify root key verifies and fetch is always manual", async () => {
  const attempts = [];
  const result = await fetchIndexNowOwnershipFile(
    ownership,
    network(async (url, init) => {
      attempts.push(url.href);
      assert.equal(init.redirect, "manual");
      return new Response(`\uFEFF${key}\n`);
    }),
  );
  assert.deepEqual(result, { verified: true });
  assert.deepEqual(attempts, [keyLocation]);
});

for (const destination of [
  "https://other.example/file.txt",
  "https://localhost/a",
  "https://10.0.0.1/a",
  "https://172.16.0.1/a",
  "https://192.168.0.1/a",
  "https://[::1]/a",
  "https://[fc00::1]/a",
  `http://${host}/a`,
  `https://${host}:8443/a`,
  "//other.example/file.txt",
  "https://[",
]) {
  test(`ownership rejects redirect before destination fetch: ${destination}`, async () => {
    const attempts = [];
    await assert.rejects(
      fetchIndexNowOwnershipFile(
        ownership,
        network(async (url) => {
          attempts.push(url.href);
          return redirect(destination);
        }),
      ),
      (error) => !error.message.includes(key),
    );
    assert.deepEqual(attempts, [keyLocation]);
  });
}

test("ownership requires root key initially, not a scoped credential path", async () => {
  let calls = 0;
  await assert.rejects(
    fetchIndexNowOwnershipFile(
      { ...ownership, keyLocation: `https://${host}/path/${key}.txt` },
      network(async () => {
        calls++;
        return new Response(key);
      }),
    ),
  );
  assert.equal(calls, 0);
});

test("same-host CDN key redirect remains supported; fragment is irrelevant", async () => {
  const attempts = [];
  await fetchIndexNowOwnershipFile(
    ownership,
    network(async (url) => {
      attempts.push(url.href);
      return attempts.length === 1
        ? redirect(`/cdn/shop/files/${key}.txt#ignored`)
        : new Response(key);
    }),
  );
  assert.deepEqual(attempts, [
    keyLocation,
    `https://${host}/cdn/shop/files/${key}.txt`,
  ]);
});

test("ownership redirect loop stops without repeating destination request", async () => {
  const attempts = [];
  await assert.rejects(
    fetchIndexNowOwnershipFile(
      ownership,
      network(async (url) => {
        attempts.push(url.href);
        return redirect(keyLocation);
      }),
    ),
    /REDIRECT_LOOP/,
  );
  assert.deepEqual(attempts, [keyLocation]);
});

test("ownership redirect count is bounded", async () => {
  const attempts = [];
  await assert.rejects(
    fetchIndexNowOwnershipFile(
      ownership,
      network(async (url) => {
        attempts.push(url.href);
        return redirect(`/next-${attempts.length}.txt`);
      }),
    ),
    /TOO_MANY_REDIRECTS/,
  );
  assert.equal(attempts.length, 6);
});

for (const address of [
  "0.0.0.0",
  "10.1.2.3",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.31.1.1",
  "192.168.1.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "fe80::1",
  "fc00::1",
  "ff02::1",
  "2001:db8::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:c0a8:101",
  "64:ff9b::a00:1",
]) {
  test(`private/reserved DNS rejected without fetch: ${address}`, async () => {
    assert.equal(isPublicAddress(address), false);
    const attempts = [];
    await assert.rejects(
      fetchPublicText(
        policy,
        network(
          async (url) => {
            attempts.push(url.href);
            return new Response(key);
          },
          async () => [{ address }],
        ),
      ),
      /NON_PUBLIC_DESTINATION/,
    );
    assert.deepEqual(attempts, []);
  });
}

test("all DNS answers must be public and each redirect hop revalidates DNS", async () => {
  let calls = 0;
  await assert.rejects(
    fetchPublicText(
      policy,
      network(
        async () => {
          calls++;
          return new Response(key);
        },
        async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }],
      ),
    ),
    /NON_PUBLIC_DESTINATION/,
  );
  assert.equal(calls, 0);
  let resolutions = 0;
  await assert.rejects(
    fetchPublicText(
      policy,
      network(
        async () => {
          calls++;
          return redirect("/next.txt");
        },
        async () => [
          { address: ++resolutions === 1 ? "93.184.216.34" : "10.0.0.1" },
        ],
      ),
    ),
    /NON_PUBLIC_DESTINATION/,
  );
  assert.equal(calls, 1);
  for (const address of [
    "93.184.216.34",
    "2606:4700:4700::1111",
    "::ffff:5db8:d822",
  ])
    assert.equal(isPublicAddress(address), true);
});

function oversized(headers = {}) {
  const state = { reads: 0, cancelled: false, signal: null };
  const body = new ReadableStream(
    {
      pull(controller) {
        state.reads++;
        controller.enqueue(new Uint8Array(600));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    state,
    fetchImpl: async (_url, init) => {
      state.signal = init.signal;
      return new Response(body, { headers });
    },
  };
}
for (const headers of [{}, { "content-length": "1" }]) {
  test(`ownership oversized stream is cancelled before complete buffering (${JSON.stringify(headers)})`, async () => {
    const h = oversized(headers);
    await assert.rejects(
      fetchIndexNowOwnershipFile(ownership, network(h.fetchImpl)),
      /BODY_TOO_LARGE/,
    );
    assert.equal(h.state.reads, 2);
    assert.equal(h.state.cancelled, true);
    assert.equal(h.state.signal.aborted, true);
  });
  test(`SEO chunked body cap holds without truthful Content-Length (${JSON.stringify(headers)})`, async () => {
    const h = oversized(headers);
    await assert.rejects(
      fetchStorefrontPage(
        {
          url: `https://${host}/products/item`,
          allowedHost: host,
          maxBodyBytes: 1024,
          maxRetries: 0,
        },
        network(h.fetchImpl),
      ),
      /SEO_AUDIT_BODY_TOO_LARGE/,
    );
    assert.equal(h.state.reads, 2);
    assert.equal(h.state.cancelled, true);
  });
}

test("early Content-Length rejection cancels without reading", async () => {
  const h = oversized({ "content-length": "999999" });
  await assert.rejects(
    fetchPublicText(policy, network(h.fetchImpl)),
    /BODY_TOO_LARGE/,
  );
  assert.equal(h.state.reads, 0);
  assert.equal(h.state.cancelled, true);
});

function stalled() {
  const state = { signal: null, cancelled: false };
  const body = new ReadableStream({
    pull: () => new Promise(() => {}),
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    state,
    fetchImpl: async (_url, init) => {
      state.signal = init.signal;
      return new Response(body);
    },
  };
}
test("ownership transport deadline covers stalled body after immediate headers", async () => {
  const h = stalled();
  await assert.rejects(
    fetchPublicText(policy, network(h.fetchImpl)),
    /FETCH_TIMEOUT/,
  );
  assert.equal(h.state.signal.aborted, true);
  assert.equal(h.state.cancelled, true);
});
test("SEO wrapper deadline covers stalled body after immediate headers", async () => {
  const h = stalled();
  await assert.rejects(
    fetchStorefrontPage(
      {
        url: `https://${host}/products/item`,
        allowedHost: host,
        timeoutMs: 1000,
        maxRetries: 0,
      },
      network(h.fetchImpl),
    ),
    /SEO_AUDIT_FETCH_TIMEOUT/,
  );
  assert.equal(h.state.signal.aborted, true);
  assert.equal(h.state.cancelled, true);
});
test("deadline also bounds a hung resolver/fetch; late fetch body is cancelled", async () => {
  let calls = 0;
  await assert.rejects(
    fetchPublicText(
      policy,
      network(
        async () => {
          calls++;
          return new Response(key);
        },
        () => new Promise(() => {}),
      ),
    ),
    /FETCH_TIMEOUT/,
  );
  assert.equal(calls, 0);
  let finish;
  let cancelled = false;
  await assert.rejects(
    fetchPublicText(
      policy,
      network(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    ),
    /FETCH_TIMEOUT/,
  );
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
test("unused redirect body cancelled; destination only fetched after checks", async () => {
  let cancelled = false;
  const attempts = [];
  await fetchPublicText(
    policy,
    network(async (url) => {
      attempts.push(url.href);
      if (attempts.length === 1)
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 302, headers: { location: "/final.txt" } },
        );
      assert.equal(cancelled, true);
      return new Response(key);
    }),
  );
  assert.equal(cancelled, true);
  assert.equal(attempts.length, 2);
});
test("SEO ports and private DNS rejected; public domain proceeds; retries bounded", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("ok", { status: 503 });
  };
  await assert.rejects(
    fetchStorefrontPage(
      { url: `https://${host}:8443/`, allowedHost: host },
      network(fetchImpl),
    ),
    /PORT_NOT_ALLOWED/,
  );
  await assert.rejects(
    fetchStorefrontPage(
      { url: `https://${host}/`, allowedHost: host },
      network(fetchImpl, async () => [{ address: "10.0.0.1" }]),
    ),
    /NON_PUBLIC_DESTINATION/,
  );
  assert.equal(calls, 0);
  const result = await fetchStorefrontPage(
    {
      url: `https://${host}/`,
      allowedHost: host,
      maxRetries: 2,
      retryBaseDelayMs: 0,
    },
    network(fetchImpl),
  );
  assert.equal(calls, 3);
  assert.equal(result.statusCode, 503);
  assert.equal(result.html, "ok");
});
test("ownership errors redact raw URL/key/internal details and full response body", async () => {
  await assert.rejects(
    fetchIndexNowOwnershipFile(
      ownership,
      network(async () => {
        throw new Error(`${keyLocation} Authorization: secret 10.0.0.1`);
      }),
    ),
    (error) => error.message === "FETCH_FAILED",
  );
  assert.equal(
    sanitizeOwnershipError(new Error(keyLocation)),
    "OWNERSHIP_FETCH_REJECTED",
  );
  await assert.rejects(
    fetchIndexNowOwnershipFile(
      ownership,
      network(async () => new Response(`bad ${key}`)),
    ),
    /OWNERSHIP_BODY_MISMATCH/,
  );
});
