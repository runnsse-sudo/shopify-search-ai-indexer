import { createHash } from "node:crypto";

export type ProductFingerprintInput = {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  productType: string;
  vendor: string;
  tags: string[];
  status: string;
  onlineStoreUrl: string | null;
  publishedAt: string | null;
  seo: { title: string | null; description: string | null } | null;
  variants: Array<{
    id: string;
    title: string;
    price: string;
    compareAtPrice: string | null;
    availableForSale: boolean;
    sku: string | null;
  }>;
  media: Array<{ id: string; alt: string | null; mediaContentType: string }>;
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\r\n/g, "\n");
}

export function normalizeProductForFingerprint(product: ProductFingerprintInput) {
  return {
    id: product.id,
    handle: normalizeText(product.handle),
    title: normalizeText(product.title),
    descriptionHtml: normalizeText(product.descriptionHtml),
    productType: normalizeText(product.productType),
    vendor: normalizeText(product.vendor),
    tags: [...product.tags].map(normalizeText).sort((a, b) => a.localeCompare(b)),
    status: product.status,
    onlineStoreUrl: product.onlineStoreUrl,
    publishedAt: product.publishedAt,
    seo: {
      title: normalizeText(product.seo?.title),
      description: normalizeText(product.seo?.description),
    },
    variants: [...product.variants]
      .map((variant) => ({
        id: variant.id,
        title: normalizeText(variant.title),
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        availableForSale: variant.availableForSale,
        sku: normalizeText(variant.sku),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    media: [...product.media]
      .map((media) => ({
        id: media.id,
        alt: normalizeText(media.alt),
        mediaContentType: media.mediaContentType,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function createProductFingerprint(product: ProductFingerprintInput) {
  const normalized = normalizeProductForFingerprint(product);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
