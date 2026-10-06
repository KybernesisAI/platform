import type { LinkCliAuthOptions } from "./link-cli-auth.js";
import { linkClient } from "./link-tools.js";
import type { SpendRequestSnapshot } from "./approve-ask.js";

/** The Link calls behind approve_spend_request. Import only from "use step" functions: this touches the filesystem and the network. */
export async function spendRequestSnapshot(id: string, options: LinkCliAuthOptions = {}): Promise<SpendRequestSnapshot | null> {
  const link = linkClient(options);
  const r = (await link.spendRequests.retrieve(id)) as (SpendRequestSnapshot & { merchant_name?: string }) | null;
  if (!r) return null;
  return { id: r.id, status: r.status, amount: r.amount, currency: r.currency, merchant: r.merchant_name ?? r.merchant, merchant_url: r.merchant_url, approval_url: r.approval_url };
}

export async function spendRequestApprovalLink(id: string, options: LinkCliAuthOptions = {}): Promise<string | undefined> {
  const link = linkClient(options);
  try {
    const r = await link.spendRequests.requestApproval(id);
    return r.approval_url;
  } catch {
    return undefined;
  }
}

/** Link settles a moment after the tap; look a few times before giving up. */
export async function spendRequestSettledStatus(id: string, options: LinkCliAuthOptions = {}): Promise<string> {
  const link = linkClient(options);
  for (let i = 0; i < 6; i++) {
    const r = await link.spendRequests.retrieve(id);
    if (r && r.status !== "pending_approval" && r.status !== "created") return r.status;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const r = await link.spendRequests.retrieve(id);
  return r?.status ?? "unknown";
}

export async function cancelSpendRequest(id: string, options: LinkCliAuthOptions = {}): Promise<void> {
  try {
    await linkClient(options).spendRequests.cancel(id);
  } catch {
    /* already terminal */
  }
}

