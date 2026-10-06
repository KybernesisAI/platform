import type { LinkCliAuthOptions } from "./link-cli-auth.js";
import { linkClient } from "./link-tools.js";

/**
 * The approval moment of a purchase, as one durable tool call.
 *
 * Link approves a spend request in the person's Link app. Before this the
 * agent pasted the approval link as text and asked them to say when they were
 * done. Now the tool asks through eve's question channel with a marker a
 * Kybernesis client renders as a card — merchant, total, an "Approve in Link"
 * button — and parks until they tap "I approved" or "Cancel". Then it checks
 * with Link and returns the real status. The model sees one result.
 */
export const SPEND_REQUEST_MARKER = "[kyb:spend-request]";

export interface SpendRequestAsk {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly merchant?: string;
  readonly merchant_url?: string;
  readonly approval_url?: string;
  readonly status: string;
}

export function spendRequestPrompt(ask: SpendRequestAsk): string {
  const total = `${(ask.amount / 100).toFixed(2)} ${ask.currency.toUpperCase()}`;
  const at = ask.merchant ? ` at ${ask.merchant}` : "";
  const link = ask.approval_url ? ` Approve it in Link: ${ask.approval_url}` : "";
  return `${SPEND_REQUEST_MARKER} ${JSON.stringify(ask)}\nA purchase of ${total}${at} is waiting for your approval.${link}`;
}

export function parseSpendRequestPrompt(prompt: string): { ask: SpendRequestAsk; text: string } | null {
  if (!prompt.startsWith(SPEND_REQUEST_MARKER)) return null;
  const nl = prompt.indexOf("\n");
  const head = nl === -1 ? prompt : prompt.slice(0, nl);
  try {
    return { ask: JSON.parse(head.slice(SPEND_REQUEST_MARKER.length).trim()) as SpendRequestAsk, text: nl === -1 ? "" : prompt.slice(nl + 1) };
  } catch {
    return null;
  }
}

export interface SpendRequestSnapshot {
  id: string;
  status: string;
  amount: number;
  currency: string;
  merchant?: string;
  merchant_url?: string;
  approval_url?: string;
}

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

/** What the agent's tool file passes to `ctx.ask` once it has a snapshot. The tool itself is authored in `agent/tools/` — eve compiles `"use workflow"` from source. */
export function spendRequestAsk(current: SpendRequestSnapshot) {
  return {
    prompt: spendRequestPrompt(current),
    display: "confirmation" as const,
    options: [
      { id: "approved", label: "I approved it in Link", style: "primary" as const },
      { id: "cancel", label: "Cancel this purchase", style: "danger" as const },
    ],
  };
}

export const APPROVE_SPEND_REQUEST_DESCRIPTION =
  "Put a spend request in front of the person for approval and wait for their answer. Call this right after create_spend_request. It shows them the merchant, the total and the Link approval button, pauses until they confirm or cancel, then returns the request's real status from Link. Only proceed to pay_on_computer when it returns approved.";
