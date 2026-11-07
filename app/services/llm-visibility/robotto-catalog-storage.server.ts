import { createHash } from "node:crypto";

const prefix = "robotto/llms-full/";
const limit = 8 * 1024 * 1024;

export function robottoCatalogStorage(bucket: string, transport: typeof fetch = fetch) {
  if (!/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("INVALID_CATALOG_BUCKET");
  const root = "https://storage.googleapis.com";
  const object = (name: string) => `${root}/storage/v1/b/${bucket}/o/${encodeURIComponent(prefix + name)}`;

  async function request(url: string, method = "GET", bytes?: Uint8Array) {
    const tokenResponse = await transport(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal: AbortSignal.timeout(5_000) },
    );
    if (!tokenResponse.ok || tokenResponse.headers.get("Metadata-Flavor") !== "Google") {
      throw new Error("CATALOG_STORAGE_AUTH_FAILED");
    }
    const { access_token: token } = await tokenResponse.json();
    if (typeof token !== "string" || !/^[!-~]+$/.test(token)) throw new Error("CATALOG_STORAGE_AUTH_FAILED");
    return transport(url, {
      method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, ...(bytes && { "Content-Type": "application/octet-stream" }) },
      body: bytes && Uint8Array.from(bytes),
    });
  }

  async function create(name: string, bytes: Uint8Array) {
    const params = new URLSearchParams({ uploadType: "media", name: prefix + name, ifGenerationMatch: "0" });
    return request(`${root}/upload/storage/v1/b/${bucket}/o?${params}`, "POST", bytes);
  }

  async function generation(response: Response, name: string) {
    if (!response.ok) throw new Error("CATALOG_STORAGE_METADATA_FAILED");
    const metadata = await response.json();
    if (metadata.bucket !== bucket || metadata.name !== prefix + name ||
        typeof metadata.generation !== "string" || !/^[1-9]\d*$/.test(metadata.generation)) {
      throw new Error("CATALOG_STORAGE_IDENTITY_MISMATCH");
    }
    return metadata.generation as string;
  }

  return {
    async withLock<T>(run: () => Promise<T>) {
      const name = "publication.lock";
      const created = await create(name, new Uint8Array());
      if (created.status === 412) throw new Error("CATALOG_PUBLICATION_LOCKED");
      const id = await generation(created, name);
      // Leave the lock in place on an uncertain outcome for manual reconciliation.
      const result = await run();
      const removed = await request(`${object(name)}?ifGenerationMatch=${id}`, "DELETE");
      if (!removed.ok) throw new Error("CATALOG_LOCK_RELEASE_UNCONFIRMED");
      return result;
    },

    async persistBackup(bytes: Uint8Array, digest: string) {
      const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
      if (bytes.length > limit || hash(bytes) !== digest) throw new Error("INVALID_CATALOG_BACKUP");
      const name = `backup/${digest}.txt`;
      const created = await create(name, bytes);
      const id = await generation(created.status === 412 ? await request(object(name)) : created, name);
      const media = await request(`${object(name)}?alt=media&generation=${id}`);
      if (!media.ok || !media.body) throw new Error("CATALOG_BACKUP_READ_FAILED");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of media.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > limit || size > bytes.length) throw new Error("CATALOG_BACKUP_SIZE_MISMATCH");
        chunks.push(chunk);
      }
      const stored = Buffer.concat(chunks, size);
      if (size !== bytes.length || hash(stored) !== digest) throw new Error("PERSISTED_BACKUP_MISMATCH");
      return stored;
    },
  };
}

export type RobottoCatalogStorage = ReturnType<typeof robottoCatalogStorage>;
