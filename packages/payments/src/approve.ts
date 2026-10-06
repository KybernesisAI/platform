import { defineWorkflowTool, type WorkflowToolDefinition } from "eve/tools";
import { z } from "zod";
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

interface Snapshot {
  id: string;
  status: string;
  amount: number;
  currency: string;
  merchant?: string;
  merchant_url?: string;
  approval_url?: string;
}

async function snapshot(id: string, options: LinkCliAuthOptions): Promise<Snapshot | null> {
  "use step";
  const link = linkClient(options);
  const r = (await link.spendRequests.retrieve(id)) as (Snapshot & { merchant_name?: string }) | null;
  if (!r) return null;
  return { id: r.id, status: r.status, amount: r.amount, currency: r.currency, merchant: r.merchant_name ?? r.merchant, merchant_url: r.merchant_url, approval_url: r.approval_url };
}

async function approvalLink(id: string, options: LinkCliAuthOptions): Promise<string | undefined> {
  "use step";
  const link = linkClient(options);
  try {
    const r = await link.spendRequests.requestApproval(id);
    return r.approval_url;
  } catch {
    return undefined;
  }
}

/** Link settles a moment after the tap; look a few times before giving up. */
async function settledStatus(id: string, options: LinkCliAuthOptions): Promise<string> {
  "use step";
  const link = linkClient(options);
  for (let i = 0; i < 6; i++) {
    const r = await link.spendRequests.retrieve(id);
    if (r && r.status !== "pending_approval" && r.status !== "created") return r.status;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const r = await link.spendRequests.retrieve(id);
  return r?.status ?? "unknown";
}

async function cancelRequest(id: string, options: LinkCliAuthOptions): Promise<void> {
  "use step";
  try {
    await linkClient(options).spendRequests.cancel(id);
  } catch {
    /* already terminal */
  }
}

export function approveSpendRequestTool(options: LinkCliAuthOptions = {}): WorkflowToolDefinition<Record<string, unknown>, unknown> {
  return defineWorkflowTool({
    description:
      "Put a spend request in front of the person for approval and wait for their answer. Call this right after create_spend_request. It shows them the merchant, the total and the Link approval button, pauses until they confirm or cancel, then returns the request's real status from Link. Only proceed to pay_on_computer when it returns approved.",
    inputSchema: z.object({ spend_request_id: z.string().min(1).max(200) }),
    async execute(input, ctx) {
      "use workflow";
      const current = await snapshot(input.spend_request_id, options);
      if (!current) return { status: "not_found", note: "That spend request does not exist." };
      if (current.status === "approved") return { status: "approved", note: "Already approved. Proceed to pay_on_computer." };
      if (current.status !== "pending_approval" && current.status !== "created") return { status: current.status, note: `This request is ${current.status}; create a new one if the purchase should still happen.` };
      const approval_url = current.approval_url ?? (await approvalLink(current.id, options));
      const answer = await ctx.ask({
        prompt: spendRequestPrompt({ ...current, approval_url }),
        display: "confirmation",
        options: [
          { id: "approved", label: "I approved it in Link", style: "primary" },
          { id: "cancel", label: "Cancel this purchase", style: "danger" },
        ],
      });
      if (answer.status !== "answered" || answer.optionId === "cancel") {
        await cancelRequest(current.id, options);
        return { status: "canceled", note: "The person cancelled. Do not buy this." };
      }
      const status = await settledStatus(current.id, options);
      if (status === "approved") return { status, note: "Approved in Link. Call pay_on_computer with this spend request id." };
      return { status, note: `Link reports ${status}. If it is still pending, the person may not have finished in the Link app; ask once, do not create another request.` };
    },
  }) as unknown as WorkflowToolDefinition<Record<string, unknown>, unknown>;
}
