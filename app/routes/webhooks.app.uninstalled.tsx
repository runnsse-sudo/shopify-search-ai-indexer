import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { revokeProviderLifecycleWithClient } from "../services/provider-lifecycle";
import { runSerializableTransactionWithRetry } from "../services/serializable-transaction-retry.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await runSerializableTransactionWithRetry(() => db.$transaction(
    (tx) => revokeProviderLifecycleWithClient(tx, shop),
    { isolationLevel: "Serializable" },
  ));

  return new Response();
};
