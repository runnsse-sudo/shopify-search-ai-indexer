import { Prisma, type IndexEventType } from "@prisma/client";
import prisma from "../db.server";
import {
  cancelPendingForProductWithClient,
  enqueueProductWithClient,
} from "./index-queue.server";
import { evaluateIndexability } from "./indexability.server";
import { determineIndexTransition } from "./index-transition";
import { createProductFingerprint } from "./product-fingerprint.server";
import {
  decideProductSnapshotOrder,
  parseShopifyUpdatedAt,
  staleDetectionResult,
  staleScanBookkeepingUpdate,
} from "./product-snapshot-order";
import { buildCanonicalProductUrl, resolvePrimaryShopDomain } from "./shop-info.server";
import { fetchProductForIndexing, type AdminGraphqlClient } from "./shopify-product.server";

export async function ensureShop(domain: string, primaryDomain?: string | null) {
  return prisma.shop.upsert({
    where: { domain },
    create: { domain, primaryDomain: primaryDomain ?? null },
    update: primaryDomain ? { primaryDomain } : {},
  });
}

export async function processProductDetection(input: {
  admin: AdminGraphqlClient;
  shopDomain: string;
  productGid: string;
  eventType: IndexEventType;
  scanRunId?: string;
  primaryDomain?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  const shop = await ensureShop(input.shopDomain);
  try {
    const product = await fetchProductForIndexing(input.admin, input.productGid);
    const snapshotObservedAt = new Date();
    if (!product) throw new Error("Product was not returned by Admin GraphQL");
    const shopifyUpdatedAt = parseShopifyUpdatedAt(product.updatedAt);
    const primaryDomain = await resolvePrimaryShopDomain(input.admin, input);
    if (primaryDomain) await ensureShop(input.shopDomain, primaryDomain);

    const candidateUrl = buildCanonicalProductUrl(primaryDomain, product.handle);
    const indexabilityState = evaluateIndexability({
      status: product.status,
      onlineStoreUrl: product.onlineStoreUrl,
      publishedAt: product.publishedAt,
    });
    const newHash = createProductFingerprint(product);

    return await prisma.$transaction(async (tx) => {
      const existing = await tx.productIndexState.findUnique({
        where: { shopId_shopifyProductGid: { shopId: shop.id, shopifyProductGid: product.id } },
      });
      const snapshotOrder = decideProductSnapshotOrder({
        existing,
        incomingShopifyUpdatedAt: shopifyUpdatedAt,
        incomingSnapshotObservedAt: snapshotObservedAt,
        incomingContentHash: newHash,
      });
      if (!snapshotOrder.accept && existing) {
        // A stale scan may record catalog membership only. Snapshot fields,
        // lastDetectedAt, and queue intent remain untouched.
        const scanUpdate = staleScanBookkeepingUpdate(input.scanRunId);
        if (input.scanRunId) {
          await tx.productIndexState.update({ where: { id: existing.id }, data: scanUpdate });
        }
        await tx.indexEvent.create({
          data: {
            shopId: shop.id,
            productIndexStateId: existing.id,
            shopifyProductGid: product.id,
            eventType: input.eventType,
            meaningfulContentChanged: false,
            oldHash: existing.contentHash,
            newHash,
            metadata: {
              ...input.metadata,
              staleSnapshot: true,
              staleReason: snapshotOrder.staleReason,
              incomingShopifyUpdatedAt: shopifyUpdatedAt.toISOString(),
              storedShopifyUpdatedAt: existing.shopifyUpdatedAt?.toISOString() ?? null,
              incomingSnapshotObservedAt: snapshotObservedAt.toISOString(),
              storedLastDetectedAt: existing.lastDetectedAt.toISOString(),
              incomingIndexability: indexabilityState,
              storedIndexability: existing.indexabilityState,
              scanRunId: input.scanRunId ?? null,
            },
          },
        });
        return staleDetectionResult(existing.indexabilityState);
      }
      const contentChanged = existing?.contentHash !== newHash;
      const wasIndexable = existing?.indexabilityState === "INDEXABLE" && !existing.deletedAt;
      const isIndexable = indexabilityState === "INDEXABLE";
      const indexabilityChanged = existing ? wasIndexable !== isIndexable : isIndexable;
      const canonicalUrl = product.onlineStoreUrl ?? existing?.canonicalUrl ?? null;
      const transition = determineIndexTransition({
        hadExistingState: Boolean(existing),
        wasIndexable,
        isIndexable,
        contentChanged,
      });

      const state = await tx.productIndexState.upsert({
        where: { shopId_shopifyProductGid: { shopId: shop.id, shopifyProductGid: product.id } },
        create: {
          shopId: shop.id,
          shopifyProductGid: product.id,
          legacyProductId: String(product.legacyResourceId),
          handle: product.handle,
          canonicalUrl,
          candidateUrl,
          title: product.title,
          productStatus: product.status,
          indexabilityState,
          published: Boolean(product.onlineStoreUrl),
          shopifyPublishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
          shopifyUpdatedAt,
          contentHash: newHash,
          lastDetectedAt: snapshotObservedAt,
          lastSeenScanRunId: input.scanRunId,
        },
        update: {
          handle: product.handle,
          canonicalUrl,
          candidateUrl,
          title: product.title,
          productStatus: product.status,
          indexabilityState,
          published: Boolean(product.onlineStoreUrl),
          shopifyPublishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
          deletedAt: null,
          shopifyUpdatedAt,
          previousContentHash: contentChanged ? existing?.contentHash : existing?.previousContentHash,
          contentHash: newHash,
          lastDetectedAt: snapshotObservedAt,
          ...(input.scanRunId ? { lastSeenScanRunId: input.scanRunId } : {}),
        },
      });

      await tx.indexEvent.create({
        data: {
          shopId: shop.id,
          productIndexStateId: state.id,
          shopifyProductGid: product.id,
          eventType: input.eventType,
          meaningfulContentChanged: contentChanged || indexabilityChanged,
          oldHash: existing?.contentHash,
          newHash,
          metadata: {
            ...input.metadata,
            previousIndexability: existing?.indexabilityState ?? null,
            indexability: indexabilityState,
            indexabilityChanged,
            onlineStoreUrl: product.onlineStoreUrl,
            publishedAt: product.publishedAt,
            scanRunId: input.scanRunId ?? null,
          },
        },
      });

      let queued = false;
      if (transition?.action === "DEINDEX") {
        await cancelPendingForProductWithClient(tx, shop.id, product.id, "INDEX");
        if (existing?.canonicalUrl) {
          const enqueued = await enqueueProductWithClient(tx, {
            shopId: shop.id,
            productIndexStateId: state.id,
            shopifyProductGid: product.id,
            url: existing.canonicalUrl,
            reason: transition.reason,
            action: "DEINDEX",
          });
          queued = enqueued.created;
        }
      } else if (transition?.action === "INDEX") {
        await cancelPendingForProductWithClient(tx, shop.id, product.id, "DEINDEX");
        const enqueued = await enqueueProductWithClient(tx, {
          shopId: shop.id,
          productIndexStateId: state.id,
          shopifyProductGid: product.id,
          url: product.onlineStoreUrl,
          reason: transition.reason,
          action: "INDEX",
        });
        queued = enqueued.created;
      }

      if (queued) {
        await tx.productIndexState.update({ where: { id: state.id }, data: { lastQueuedAt: new Date() } });
      }
      return { changed: contentChanged || indexabilityChanged, queued, stale: false, indexabilityState };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown product processing error";
    await prisma.indexEvent.create({
      data: {
        shopId: shop.id,
        shopifyProductGid: input.productGid,
        eventType: input.eventType,
        meaningfulContentChanged: false,
        metadata: { ...input.metadata, scanRunId: input.scanRunId ?? null },
        error: message.slice(0, 4000),
      },
    });
    throw error;
  }
}

export async function processProductDeletion(input: {
  shopDomain: string;
  productGid: string;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  const shop = await ensureShop(input.shopDomain);
  return prisma.$transaction(async (tx) => {
    let state = await tx.productIndexState.findUnique({
      where: { shopId_shopifyProductGid: { shopId: shop.id, shopifyProductGid: input.productGid } },
    });
    const hadState = Boolean(state);
    const alreadyDeleted = Boolean(state?.deletedAt);

    if (!state) {
      state = await tx.productIndexState.create({
        data: {
          shopId: shop.id,
          shopifyProductGid: input.productGid,
          deletedAt: new Date(),
          published: false,
          indexabilityState: "NOT_PUBLISHED",
        },
      });
    } else if (!alreadyDeleted) {
      await cancelPendingForProductWithClient(tx, shop.id, input.productGid, "INDEX");
      if (state.canonicalUrl) {
        await enqueueProductWithClient(tx, {
          shopId: shop.id,
          productIndexStateId: state.id,
          shopifyProductGid: input.productGid,
          url: state.canonicalUrl,
          reason: "DELETED",
          action: "DEINDEX",
        });
      }
      await tx.productIndexState.update({
        where: { id: state.id },
        data: {
          deletedAt: new Date(),
          published: false,
          indexabilityState: "NOT_PUBLISHED",
        },
      });
    }

    await tx.indexEvent.create({
      data: {
        shopId: shop.id,
        productIndexStateId: state?.id,
        shopifyProductGid: input.productGid,
        eventType: "DELETED",
        meaningfulContentChanged: hadState && !alreadyDeleted,
        oldHash: state?.contentHash,
        metadata: { ...input.metadata, alreadyDeleted, previousPublicUrl: state?.canonicalUrl ?? null },
      },
    });
    return { alreadyDeleted };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
