import type { PrismaClient } from "@prisma/client";
import { applyWorkbenchCommand, WorkbenchError, type WorkbenchCommand } from "./product-workbench";

// Deployment of code does not grant authority to introduce queue writes.
export const workbenchActionsEnabled = () => process.env.PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED === "true";

export function workbenchFailure(error: unknown) {
  const status = error instanceof WorkbenchError ? error.status : 503;
  const message = status === 403 ? "Queue actions are unavailable for this request."
    : status === 409 ? "The selection or queue changed. Refresh and review before submitting again."
    : status >= 500 ? "The request could not be confirmed. Refresh the queue before taking further action."
    : "Choose up to 20 current products and submit from this app.";
  return { status, message };
}

export async function executeWorkbenchCommand(client: PrismaClient, domain: string, owner: string, command: WorkbenchCommand) {
  if (!workbenchActionsEnabled()) throw new WorkbenchError("ACTIONS_DISABLED", 403);
  try {
    return await client.$transaction((tx) => applyWorkbenchCommand(tx, domain, owner, command), {
      isolationLevel: "Serializable", maxWait: 2000, timeout: 5000,
    });
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    if (error && typeof error === "object" && "code" in error && ["P2034", "P2002"].includes(String(error.code))) throw new WorkbenchError("CONCURRENT_CHANGE", 409);
    throw error;
  }
}
