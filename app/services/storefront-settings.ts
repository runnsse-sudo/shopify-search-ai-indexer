export const STOREFRONT_SETTINGS_VERSION =
  1 as const;

export const STOREFRONT_SETTINGS_NAMESPACE =
  "runn_storefront";

export const STOREFRONT_SETTINGS_KEY =
  "config_v1";

export const STOREFRONT_SETTINGS_TYPE =
  "json";

export type StorefrontSettings = {
  version: 1;

  identity: {
    founder: string;
    facebookUrl: string;
    instagramUrl: string;
    xUrl: string;
    aboutUrl: string;
    contactUrl: string;
  };

  shipping: {
    enabled: boolean;
    country: string;
    rate: number;
    currency: string;
    label: string;
    minimumDeliveryDays: number | null;
    maximumDeliveryDays: number | null;
    policyUrl: string;
  };

  returns: {
    enabled: boolean;
    country: string;
    periodDays: number;
    method: "ReturnByMail";
    fees: "CustomerResponsibility";
    refundType: "FullRefund";
    policyUrl: string;
  };
};

type JsonRecord =
  Record<string, unknown>;

function requireRecord(
  value: unknown,
  label: string,
): JsonRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(
      `${label} must be an object`,
    );
  }

  return value as JsonRecord;
}

function requireString(
  record: JsonRecord,
  key: string,
  label: string,
) {
  const value =
    record[key];

  if (typeof value !== "string") {
    throw new Error(
      `${label}.${key} must be a string`,
    );
  }

  return value.trim();
}

function requireBoolean(
  record: JsonRecord,
  key: string,
  label: string,
) {
  const value =
    record[key];

  if (typeof value !== "boolean") {
    throw new Error(
      `${label}.${key} must be a boolean`,
    );
  }

  return value;
}

function requireNumber(
  record: JsonRecord,
  key: string,
  label: string,
) {
  const value =
    record[key];

  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    throw new Error(
      `${label}.${key} must be a finite number`,
    );
  }

  return value;
}

function normalizeAbsoluteUrl(
  value: string,
  label: string,
) {
  if (!value) {
    return "";
  }

  let url: URL;

  try {
    url =
      new URL(value);
  } catch {
    throw new Error(
      `${label} must be an absolute URL`,
    );
  }

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new Error(
      `${label} must use http or https`,
    );
  }

  return url.toString();
}

function normalizeStoreUrl(
  value: string,
  label: string,
) {
  if (!value) {
    return "";
  }

  if (
    value.startsWith("/") &&
    !value.startsWith("//")
  ) {
    const base =
      "https://store.invalid";

    const url =
      new URL(
        value,
        base,
      );

    if (url.origin !== base) {
      throw new Error(
        `${label} must be an absolute http(s) URL or a store-relative path`,
      );
    }

    return (
      url.pathname +
      url.search +
      url.hash
    );
  }

  return normalizeAbsoluteUrl(
    value,
    label,
  );
}
function normalizeCountry(
  value: string,
  label: string,
) {
  const normalized =
    value.toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(
      `${label} must be a two-letter country code`,
    );
  }

  return normalized;
}

function normalizeCurrency(
  value: string,
  label: string,
) {
  const normalized =
    value.toUpperCase();

  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(
      `${label} must be a three-letter currency code`,
    );
  }

  return normalized;
}

function requireIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

export function createDefaultStorefrontSettings():
  StorefrontSettings {
  return {
    version:
      STOREFRONT_SETTINGS_VERSION,

    identity: {
      founder: "",
      facebookUrl: "",
      instagramUrl: "",
      xUrl: "",
      aboutUrl: "",
      contactUrl: "",
    },

    shipping: {
      enabled: false,
      country: "SE",
      rate: 49,
      currency: "SEK",
      label: "Standardfrakt",
      minimumDeliveryDays: null,
      maximumDeliveryDays: null,
      policyUrl: "",
    },

    returns: {
      enabled: false,
      country: "SE",
      periodDays: 14,
      method: "ReturnByMail",
      fees: "CustomerResponsibility",
      refundType: "FullRefund",
      policyUrl: "",
    },
  };
}

export function normalizeStorefrontSettings(
  input: unknown,
): StorefrontSettings {
  const root =
    requireRecord(
      input,
      "storefront settings",
    );

  if (
    root.version !==
    STOREFRONT_SETTINGS_VERSION
  ) {
    throw new Error(
      "storefront settings.version must be 1",
    );
  }

  const identity =
    requireRecord(
      root.identity,
      "identity",
    );

  const shipping =
    requireRecord(
      root.shipping,
      "shipping",
    );

  const returns =
    requireRecord(
      root.returns,
      "returns",
    );

  const shippingEnabled =
    requireBoolean(
      shipping,
      "enabled",
      "shipping",
    );

  const shippingRate =
    requireNumber(
      shipping,
      "rate",
      "shipping",
    );

  if (
    shippingRate < 0 ||
    shippingRate > 1000000
  ) {
    throw new Error(
      "shipping.rate must be between 0 and 1000000",
    );
  }

  const shippingLabel =
    requireString(
      shipping,
      "label",
      "shipping",
    );

  if (
    shippingEnabled &&
    !shippingLabel
  ) {
    throw new Error(
      "shipping.label is required when shipping is enabled",
    );
  }

  const minimumDeliveryDays = requireNullableDeliveryDays(
    shipping,
    "minimumDeliveryDays",
  );
  const maximumDeliveryDays = requireNullableDeliveryDays(
    shipping,
    "maximumDeliveryDays",
  );
  if ((minimumDeliveryDays === null) !== (maximumDeliveryDays === null)) {
    throw new Error("Delivery timing must be both null or both numeric");
  }
  if (
    minimumDeliveryDays !== null &&
    maximumDeliveryDays !== null &&
    minimumDeliveryDays > maximumDeliveryDays
  ) {
    throw new Error(
      "shipping.minimumDeliveryDays cannot exceed shipping.maximumDeliveryDays",
    );
  }

  const returnsEnabled =
    requireBoolean(
      returns,
      "enabled",
      "returns",
    );

  const periodDays =
    requireIntegerRange(
      requireNumber(
        returns,
        "periodDays",
        "returns",
      ),
      0,
      3650,
      "returns.periodDays",
    );

  if (
    returnsEnabled &&
    periodDays < 1
  ) {
    throw new Error(
      "returns.periodDays must be at least 1 when returns are enabled",
    );
  }

  const method =
    requireString(
      returns,
      "method",
      "returns",
    );

  if (method !== "ReturnByMail") {
    throw new Error(
      "returns.method must be ReturnByMail in Storefront Settings V1",
    );
  }

  const fees =
    requireString(
      returns,
      "fees",
      "returns",
    );

  if (
    fees !==
    "CustomerResponsibility"
  ) {
    throw new Error(
      "returns.fees must be CustomerResponsibility in Storefront Settings V1",
    );
  }

  const refundType =
    requireString(
      returns,
      "refundType",
      "returns",
    );

  if (
    refundType !==
    "FullRefund"
  ) {
    throw new Error(
      "returns.refundType must be FullRefund in Storefront Settings V1",
    );
  }

  return {
    version:
      STOREFRONT_SETTINGS_VERSION,

    identity: {
      founder:
        requireString(
          identity,
          "founder",
          "identity",
        ),

      facebookUrl:
        normalizeAbsoluteUrl(
          requireString(
            identity,
            "facebookUrl",
            "identity",
          ),
          "identity.facebookUrl",
        ),

      instagramUrl:
        normalizeAbsoluteUrl(
          requireString(
            identity,
            "instagramUrl",
            "identity",
          ),
          "identity.instagramUrl",
        ),

      xUrl:
        normalizeAbsoluteUrl(
          requireString(
            identity,
            "xUrl",
            "identity",
          ),
          "identity.xUrl",
        ),

      aboutUrl:
        normalizeStoreUrl(
          requireString(
            identity,
            "aboutUrl",
            "identity",
          ),
          "identity.aboutUrl",
        ),

      contactUrl:
        normalizeStoreUrl(
          requireString(
            identity,
            "contactUrl",
            "identity",
          ),
          "identity.contactUrl",
        ),
    },

    shipping: {
      enabled:
        shippingEnabled,

      country:
        normalizeCountry(
          requireString(
            shipping,
            "country",
            "shipping",
          ),
          "shipping.country",
        ),

      rate:
        shippingRate,

      currency:
        normalizeCurrency(
          requireString(
            shipping,
            "currency",
            "shipping",
          ),
          "shipping.currency",
        ),

      label:
        shippingLabel,

      minimumDeliveryDays,
      maximumDeliveryDays,

      policyUrl:
        normalizeStoreUrl(
          requireString(
            shipping,
            "policyUrl",
            "shipping",
          ),
          "shipping.policyUrl",
        ),
    },

    returns: {
      enabled:
        returnsEnabled,

      country:
        normalizeCountry(
          requireString(
            returns,
            "country",
            "returns",
          ),
          "returns.country",
        ),

      periodDays,

      method,
      fees,
      refundType,

      policyUrl:
        normalizeStoreUrl(
          requireString(
            returns,
            "policyUrl",
            "returns",
          ),
          "returns.policyUrl",
        ),
    },
  };
}

export function stringifyStorefrontSettings(
  input: unknown,
) {
  return JSON.stringify(
    normalizeStorefrontSettings(
      input,
    ),
  );
}
function requireNullableDeliveryDays(
  record: JsonRecord,
  key: string,
): number | null {
  if (record[key] === null) return null;
  return requireIntegerRange(
    requireNumber(record, key, "shipping"),
    0,
    365,
    "shipping." + key,
  );
}

/** Form-only blank handling; persisted JSON must contain explicit nulls. */
export function getFormDeliveryDays(
  formData: FormData,
  key: string,
): number | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") throw new Error(key + " must be a form string");
  if (!raw.trim()) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value))
    throw new Error(key + " must be a finite number");
  return value;
}
