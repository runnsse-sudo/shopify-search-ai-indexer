import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndexNowRootKeyLocation,
  indexNowShopReadinessReason,
  normalizeIndexNowHost,
  validateIndexNowCredentialPayload,
} from "../app/services/indexnow-shop-config.ts";

test(
  "IndexNow host normalization accepts only public hostname form",
  () => {
    assert.equal(
      normalizeIndexNowHost(
        " WWW.Example.COM ",
      ),
      "www.example.com",
    );

    for (const value of [
      "https://example.com",
      "localhost",
      "127.0.0.1",
      "example.com/path",
    ]) {
      assert.throws(
        () =>
          normalizeIndexNowHost(
            value,
          ),
      );
    }
  },
);

test(
  "root key location binds exact key and host",
  () => {
    const key =
      "abcdef1234567890";

    const location =
      buildIndexNowRootKeyLocation(
        "www.example.com",
        key,
      );

    assert.equal(
      location,
      `https://www.example.com/${key}.txt`,
    );

    assert.deepEqual(
      validateIndexNowCredentialPayload(
        {
          version: 1,
          key,
          keyLocation:
            location,
        },
        "www.example.com",
      ),
      {
        version: 1,
        key,
        keyLocation:
          location,
        allowedHost:
          "www.example.com",
      },
    );

    assert.throws(
      () =>
        validateIndexNowCredentialPayload(
          {
            version: 1,
            key,
            keyLocation:
              `https://other.example.com/${key}.txt`,
          },
          "www.example.com",
        ),
      /root key location/,
    );
  },
);

test(
  "shop readiness requires enablement, credentials, verification and unchanged domain",
  () => {
    const ready = {
      enabled: true,

      primaryDomain:
        "www.example.com",

      allowedHost:
        "www.example.com",

      credentialCiphertext:
        "cipher",

      credentialIv:
        "iv",

      credentialTag:
        "tag",

      ownershipVerifiedAt:
        new Date(),
    };

    assert.equal(
      indexNowShopReadinessReason(
        ready,
      ),
      null,
    );

    assert.equal(
      indexNowShopReadinessReason({
        ...ready,
        enabled: false,
      }),
      "INDEXNOW_DISABLED",
    );

    assert.equal(
      indexNowShopReadinessReason({
        ...ready,
        ownershipVerifiedAt:
          null,
      }),
      "OWNERSHIP_NOT_VERIFIED",
    );

    assert.equal(
      indexNowShopReadinessReason({
        ...ready,
        primaryDomain:
          "changed.example.com",
      }),
      "PRIMARY_DOMAIN_CHANGED",
    );
  },
);