import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  getStorefrontSettings,
  saveStorefrontSettings,
} from "../services/storefront-settings.server";

function getFormString(
  formData: FormData,
  key: string,
) {
  const value =
    formData.get(key);

  if (typeof value !== "string") {
    throw new Error(
      `${key} must be a form string`,
    );
  }

  return value;
}

function getFormNumber(
  formData: FormData,
  key: string,
) {
  const raw =
    getFormString(
      formData,
      key,
    ).trim();

  if (!raw) {
    throw new Error(
      `${key} is required`,
    );
  }

  const value =
    Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(
      `${key} must be a finite number`,
    );
  }

  return value;
}

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  const { admin } =
    await authenticate.admin(
      request,
    );

  return {
    snapshot:
      await getStorefrontSettings(
        admin,
      ),
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  const {
    admin,
    session,
  } =
    await authenticate.admin(
      request,
    );

  const formData =
    await request.formData();

  try {
    const intent =
      getFormString(
        formData,
        "intent",
      );

    if (intent !== "save") {
      return {
        ok: false,
        error:
          "Unknown storefront settings action.",
        snapshot: null,
      };
    }

    const digest =
      getFormString(
        formData,
        "compareDigest",
      ).trim();

    const snapshot =
      await saveStorefrontSettings(
        admin,
        {
          version:
            1 as const,

          identity: {
            founder:
              getFormString(
                formData,
                "identity.founder",
              ),

            facebookUrl:
              getFormString(
                formData,
                "identity.facebookUrl",
              ),

            instagramUrl:
              getFormString(
                formData,
                "identity.instagramUrl",
              ),

            xUrl:
              getFormString(
                formData,
                "identity.xUrl",
              ),

            aboutUrl:
              getFormString(
                formData,
                "identity.aboutUrl",
              ),

            contactUrl:
              getFormString(
                formData,
                "identity.contactUrl",
              ),
          },

          shipping: {
            enabled:
              formData.has(
                "shipping.enabled",
              ),

            country:
              getFormString(
                formData,
                "shipping.country",
              ),

            rate:
              getFormNumber(
                formData,
                "shipping.rate",
              ),

            currency:
              getFormString(
                formData,
                "shipping.currency",
              ),

            label:
              getFormString(
                formData,
                "shipping.label",
              ),

            minimumDeliveryDays:
              getFormNumber(
                formData,
                "shipping.minimumDeliveryDays",
              ),

            maximumDeliveryDays:
              getFormNumber(
                formData,
                "shipping.maximumDeliveryDays",
              ),

            policyUrl:
              getFormString(
                formData,
                "shipping.policyUrl",
              ),
          },

          returns: {
            enabled:
              formData.has(
                "returns.enabled",
              ),

            country:
              getFormString(
                formData,
                "returns.country",
              ),

            periodDays:
              getFormNumber(
                formData,
                "returns.periodDays",
              ),

            method:
              "ReturnByMail" as const,

            fees:
              "CustomerResponsibility" as const,

            refundType:
              "FullRefund" as const,

            policyUrl:
              getFormString(
                formData,
                "returns.policyUrl",
              ),
          },
        },

        digest || null,
      );

    return {
      ok: true,
      error: null,
      snapshot,
    };
  } catch (error) {
    console.error(
      "Storefront settings save failed",
      {
        shop:
          session.shop,

        error,
      },
    );

    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Storefront settings save failed.",
      snapshot: null,
    };
  }
};

function TextField({
  label,
  name,
  defaultValue,
  type = "text",
  step,
  min,
  max,
}: {
  label: string;
  name: string;
  defaultValue: string | number;
  type?: "text" | "url" | "number";
  step?: string;
  min?: number;
  max?: number;
}) {
  return (
    <p>
      <label>
        {label}
        <br />

        <input
          type={type}
          name={name}
          defaultValue={defaultValue}
          {...(
            step !== undefined
              ? { step }
              : {}
          )}
          {...(
            min !== undefined
              ? { min }
              : {}
          )}
          {...(
            max !== undefined
              ? { max }
              : {}
          )}
        />
      </label>
    </p>
  );
}

function CheckboxField({
  label,
  name,
  defaultChecked,
}: {
  label: string;
  name: string;
  defaultChecked: boolean;
}) {
  return (
    <p>
      <label>
        <input
          type="checkbox"
          name={name}
          value="true"
          defaultChecked={
            defaultChecked
          }
        />{" "}

        {label}
      </label>
    </p>
  );
}

export default function StorefrontSettings() {
  const {
    snapshot:
      loadedSnapshot,
  } =
    useLoaderData<
      typeof loader
    >();

  const fetcher =
    useFetcher<
      typeof action
    >();

  const snapshot =
    fetcher.data?.snapshot ??
    loadedSnapshot;

  const config =
    snapshot.config;

  const busy =
    fetcher.state !== "idle";

  return (
    <s-page heading="Storefront settings">
      <s-section heading="Structured storefront information">
        <s-paragraph>
          Configure merchant identity, shipping and return
          information for the storefront schema configuration.
          Saving writes the app-owned config_v1 metafield for
          this Shopify installation.
        </s-paragraph>

        <s-unordered-list>
          <s-list-item>
            Storage: {snapshot.exists ? "Configured" : "Not configured yet"}
          </s-list-item>

          <s-list-item>
            Configuration version: {config.version}
          </s-list-item>

          <s-list-item>
            Concurrent-write protection: Active
          </s-list-item>
        </s-unordered-list>

        <s-paragraph>
          This step stores configuration only. Storefront
          schema output is not changed until the schema
          extension integration is completed separately.
        </s-paragraph>
      </s-section>

      <fetcher.Form
        key={
          snapshot.compareDigest ??
          "new-config"
        }
        method="post"
      >
        <input
          type="hidden"
          name="intent"
          value="save"
          readOnly
        />

        <input
          type="hidden"
          name="compareDigest"
          value={
            snapshot.compareDigest ??
            ""
          }
          readOnly
        />

        <s-section heading="Identity">
          <TextField
            label="Founder / owner name"
            name="identity.founder"
            defaultValue={
              config.identity.founder
            }
          />

          <TextField
            label="Facebook URL"
            name="identity.facebookUrl"
            type="url"
            defaultValue={
              config.identity.facebookUrl
            }
          />

          <TextField
            label="Instagram URL"
            name="identity.instagramUrl"
            type="url"
            defaultValue={
              config.identity.instagramUrl
            }
          />

          <TextField
            label="X / Twitter URL"
            name="identity.xUrl"
            type="url"
            defaultValue={
              config.identity.xUrl
            }
          />

          <TextField
            label="About page URL or store-relative path"
            name="identity.aboutUrl"
            defaultValue={
              config.identity.aboutUrl
            }
          />

          <TextField
            label="Contact page URL or store-relative path"
            name="identity.contactUrl"
            defaultValue={
              config.identity.contactUrl
            }
          />
        </s-section>

        <s-section heading="Shipping">
          <CheckboxField
            label="Publish shipping details"
            name="shipping.enabled"
            defaultChecked={
              config.shipping.enabled
            }
          />

          <TextField
            label="Country code"
            name="shipping.country"
            defaultValue={
              config.shipping.country
            }
          />

          <TextField
            label="Shipping rate"
            name="shipping.rate"
            type="number"
            step="0.01"
            min={0}
            max={1000000}
            defaultValue={
              config.shipping.rate
            }
          />

          <TextField
            label="Currency"
            name="shipping.currency"
            defaultValue={
              config.shipping.currency
            }
          />

          <TextField
            label="Shipping label"
            name="shipping.label"
            defaultValue={
              config.shipping.label
            }
          />

          <TextField
            label="Minimum delivery days"
            name="shipping.minimumDeliveryDays"
            type="number"
            step="1"
            min={0}
            max={365}
            defaultValue={
              config.shipping.minimumDeliveryDays
            }
          />

          <TextField
            label="Maximum delivery days"
            name="shipping.maximumDeliveryDays"
            type="number"
            step="1"
            min={0}
            max={365}
            defaultValue={
              config.shipping.maximumDeliveryDays
            }
          />

          <TextField
            label="Shipping policy URL or store-relative path"
            name="shipping.policyUrl"
            defaultValue={
              config.shipping.policyUrl
            }
          />
        </s-section>

        <s-section heading="Returns">
          <CheckboxField
            label="Publish return details"
            name="returns.enabled"
            defaultChecked={
              config.returns.enabled
            }
          />

          <TextField
            label="Country code"
            name="returns.country"
            defaultValue={
              config.returns.country
            }
          />

          <TextField
            label="Return period in days"
            name="returns.periodDays"
            type="number"
            step="1"
            min={0}
            max={3650}
            defaultValue={
              config.returns.periodDays
            }
          />

          <TextField
            label="Return policy URL or store-relative path"
            name="returns.policyUrl"
            defaultValue={
              config.returns.policyUrl
            }
          />

          <s-paragraph>
            Storefront Settings V1 stores ReturnByMail,
            CustomerResponsibility and FullRefund for
            future storefront return-policy schema output.
          </s-paragraph>
        </s-section>

        <s-section heading="Save">
          <button
            type="submit"
            disabled={busy}
          >
            {
              busy
                ? "Saving..."
                : "Save storefront settings"
            }
          </button>

          {
            fetcher.data?.ok === true
              ? (
                <p>
                  Storefront settings saved.
                </p>
              )
              : null
          }

          {
            fetcher.data?.error
              ? (
                <p>
                  Save failed: {fetcher.data.error}
                </p>
              )
              : null
          }
        </s-section>
      </fetcher.Form>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(
    useRouteError(),
  );
}

export const headers: HeadersFunction =
  (headersArgs) =>
    boundary.headers(
      headersArgs,
    );
