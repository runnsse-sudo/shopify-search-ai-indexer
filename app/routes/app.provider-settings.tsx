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
  getIndexNowShopStatus,
  prepareIndexNowShopSetup,
  setIndexNowShopEnabled,
  verifyIndexNowShopOwnership,
} from "../services/indexnow-shop-config.server";

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  const { session } =
    await authenticate.admin(
      request,
    );

  return {
    status:
      await getIndexNowShopStatus(
        session.shop,
      ),
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  const { session } =
    await authenticate.admin(
      request,
    );

  const formData =
    await request.formData();

  const intent =
    String(
      formData.get("intent") ?? "",
    );

  try {
    if (intent === "prepare") {
      const setup =
        await prepareIndexNowShopSetup(
          session.shop,
        );

      return {
        ok: true,
        error: null,
        setup,
      };
    }

    if (intent === "verify") {
      await verifyIndexNowShopOwnership(
        session.shop,
      );

      return {
        ok: true,
        error: null,
        setup: null,
      };
    }

    if (intent === "enable") {
      await setIndexNowShopEnabled(
        session.shop,
        true,
      );

      return {
        ok: true,
        error: null,
        setup: null,
      };
    }

    if (intent === "disable") {
      await setIndexNowShopEnabled(
        session.shop,
        false,
      );

      return {
        ok: true,
        error: null,
        setup: null,
      };
    }

    return {
      ok: false,
      error:
        "Unknown provider action.",
      setup: null,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Provider configuration failed.",
      setup: null,
    };
  }
};

export default function ProviderSettings() {
  const { status } =
    useLoaderData<
      typeof loader
    >();

  const fetcher =
    useFetcher<
      typeof action
    >();

  const setup =
    fetcher.data?.setup ?? null;

  const busy =
    fetcher.state !== "idle";

  return (
    <s-page heading="IndexNow provider">
      <s-section heading="Shop-specific configuration">
        <s-paragraph>
          Each Shopify shop has its own IndexNow key,
          ownership verification and provider enablement.
          Credentials are encrypted before they are stored.
        </s-paragraph>

        <s-unordered-list>
          <s-list-item>
            Primary domain: {status.primaryDomain ?? "Not discovered"}
          </s-list-item>

          <s-list-item>
            Allowed host: {status.allowedHost ?? "Not configured"}
          </s-list-item>

          <s-list-item>
            Credentials: {status.configured ? "Configured" : "Not configured"}
          </s-list-item>

          <s-list-item>
            Ownership: {status.ownershipVerified ? "Verified" : "Not verified"}
          </s-list-item>

          <s-list-item>
            Provider: {status.enabled ? "Enabled" : "Disabled"}
          </s-list-item>

          <s-list-item>
            Readiness: {status.readinessReason ?? "READY"}
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="1. Prepare ownership key">
        <s-paragraph>
          Preparing a new key disables IndexNow for this
          shop until ownership is verified again.
        </s-paragraph>

        <fetcher.Form method="post">
          <input
            type="hidden"
            name="intent"
            value="prepare"
          />

          <button
            type="submit"
            disabled={busy}
          >
            Prepare / rotate IndexNow key
          </button>
        </fetcher.Form>

        {setup ? (
          <div>
            <p>
              Publish this exact text at the exact root URL below.
              The key is shown here so the shop owner can complete
              ownership setup.
            </p>

            <p>
              <strong>Key</strong>
            </p>

            <pre>{setup.key}</pre>

            <p>
              <strong>Required root URL</strong>
            </p>

            <pre>{setup.keyLocation}</pre>
          </div>
        ) : null}
      </s-section>

      <s-section heading="2. Verify ownership">
        <s-paragraph>
          Verification requires the root URL to resolve successfully
          and return the exact configured key.
        </s-paragraph>

        <fetcher.Form method="post">
          <input
            type="hidden"
            name="intent"
            value="verify"
          />

          <button
            type="submit"
            disabled={busy || !status.configured}
          >
            Verify IndexNow ownership
          </button>
        </fetcher.Form>

        {status.ownershipError ? (
          <p>
            Last verification error: {status.ownershipError}
          </p>
        ) : null}
      </s-section>

      <s-section heading="3. Provider enablement">
        <s-paragraph>
          External provider execution remains fail-closed until
          ownership has been verified for this exact shop.
        </s-paragraph>

        <s-stack
          direction="inline"
          gap="base"
        >
          <fetcher.Form method="post">
            <input
              type="hidden"
              name="intent"
              value="enable"
            />

            <button
              type="submit"
              disabled={
                busy ||
                !status.ownershipVerified
              }
            >
              Enable IndexNow
            </button>
          </fetcher.Form>

          <fetcher.Form method="post">
            <input
              type="hidden"
              name="intent"
              value="disable"
            />

            <button
              type="submit"
              disabled={busy}
            >
              Disable IndexNow
            </button>
          </fetcher.Form>
        </s-stack>
      </s-section>

      {fetcher.data?.error ? (
        <s-section heading="Result">
          <s-paragraph>
            {fetcher.data.error}
          </s-paragraph>
        </s-section>
      ) : null}
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