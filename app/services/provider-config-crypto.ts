import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export type EncryptedProviderCredential =
  Readonly<{
    ciphertext: string;
    iv: string;
    tag: string;
  }>;

function parseBase64Part(
  value: string,
  name: string,
) {
  try {
    const parsed = Buffer.from(
      value,
      "base64",
    );

    if (parsed.length === 0) {
      throw new Error();
    }

    return parsed;
  } catch {
    throw new Error(
      `${name} is invalid`,
    );
  }
}

export function parseProviderConfigMasterKey(
  value: string | undefined,
) {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error(
      "PROVIDER_CONFIG_MASTER_KEY is required",
    );
  }

  let key: Buffer;

  try {
    key = Buffer.from(
      normalized,
      "base64",
    );
  } catch {
    throw new Error(
      "PROVIDER_CONFIG_MASTER_KEY must be base64",
    );
  }

  if (key.length !== 32) {
    throw new Error(
      "PROVIDER_CONFIG_MASTER_KEY must decode to exactly 32 bytes",
    );
  }

  return key;
}

export function encryptProviderCredential(
  plaintext: string,
  masterKeyValue: string | undefined,
): EncryptedProviderCredential {
  const masterKey =
    parseProviderConfigMasterKey(
      masterKeyValue,
    );

  const iv = randomBytes(12);

  const cipher = createCipheriv(
    "aes-256-gcm",
    masterKey,
    iv,
  );

  const encrypted = Buffer.concat([
    cipher.update(
      plaintext,
      "utf8",
    ),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    ciphertext:
      encrypted.toString("base64"),
    iv:
      iv.toString("base64"),
    tag:
      tag.toString("base64"),
  };
}

export function decryptProviderCredential(
  encrypted:
    EncryptedProviderCredential,
  masterKeyValue: string | undefined,
) {
  const masterKey =
    parseProviderConfigMasterKey(
      masterKeyValue,
    );

  const iv = parseBase64Part(
    encrypted.iv,
    "provider credential IV",
  );

  const ciphertext =
    parseBase64Part(
      encrypted.ciphertext,
      "provider credential ciphertext",
    );

  const tag = parseBase64Part(
    encrypted.tag,
    "provider credential tag",
  );

  if (iv.length !== 12) {
    throw new Error(
      "provider credential IV must be 12 bytes",
    );
  }

  if (tag.length !== 16) {
    throw new Error(
      "provider credential tag must be 16 bytes",
    );
  }

  try {
    const decipher =
      createDecipheriv(
        "aes-256-gcm",
        masterKey,
        iv,
      );

    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "provider credential could not be decrypted",
    );
  }
}