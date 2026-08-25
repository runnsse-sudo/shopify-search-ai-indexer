import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptProviderCredential,
  encryptProviderCredential,
  parseProviderConfigMasterKey,
} from "../app/services/provider-config-crypto.ts";

const MASTER =
  Buffer.alloc(32, 7)
    .toString("base64");

test(
  "provider config master key must decode to exactly 32 bytes",
  () => {
    assert.equal(
      parseProviderConfigMasterKey(
        MASTER,
      ).length,
      32,
    );

    assert.throws(
      () =>
        parseProviderConfigMasterKey(
          undefined,
        ),
      /required/,
    );

    assert.throws(
      () =>
        parseProviderConfigMasterKey(
          Buffer.alloc(31)
            .toString("base64"),
        ),
      /32 bytes/,
    );
  },
);

test(
  "provider credential encryption round-trips and uses a new IV",
  () => {
    const plaintext =
      JSON.stringify({
        key:
          "example-key",

        keyLocation:
          "https://example.com/example-key.txt",
      });

    const first =
      encryptProviderCredential(
        plaintext,
        MASTER,
      );

    const second =
      encryptProviderCredential(
        plaintext,
        MASTER,
      );

    assert.notEqual(
      first.iv,
      second.iv,
    );

    assert.notEqual(
      first.ciphertext,
      plaintext,
    );

    assert.equal(
      decryptProviderCredential(
        first,
        MASTER,
      ),
      plaintext,
    );
  },
);

test(
  "tampered provider credential is rejected",
  () => {
    const encrypted =
      encryptProviderCredential(
        "credential",
        MASTER,
      );

    assert.throws(
      () =>
        decryptProviderCredential(
          {
            ...encrypted,

            tag:
              Buffer.alloc(16, 1)
                .toString("base64"),
          },
          MASTER,
        ),
      /could not be decrypted/,
    );
  },
);