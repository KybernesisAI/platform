
/**
 * The approval moment of a purchase: the pure half (no Node imports), safe
 * inside a workflow driver bundle. The Link calls live in ./approve-steps.js.
 *
 * Link approves a spend request in the person's Link app. Before this the
 * agent pasted the approval link as text and asked them to say when they were
 * done. Now the tool asks through eve's question channel with a marker a
 * Kybernesis client renders as a card — merchant, total, an "Approve in Link"
 * button — and parks until they tap "I approved" or "Cancel". Then it checks
 * with Link and returns the real status. The model sees one result.
 *
 * Text-only channels (iMessage) cannot show the buttons, and eve only matches a
 * plain reply to an option by its exact id or label. So the question also takes
 * free text: a reply that reads as a no cancels, anything else means "check
 * Link". Link's own status still decides whether the purchase goes ahead.
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
  return `${SPEND_REQUEST_MARKER} ${JSON.stringify(ask)}\nA purchase of ${total}${at} is waiting for your approval.${link} Reply once you have approved it, or say cancel.`;
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

/** What the agent's tool file passes to `ctx.ask` once it has a snapshot. The tool itself is authored in `agent/tools/` — eve compiles `"use workflow"` from source. */
export function spendRequestAsk(current: SpendRequestSnapshot) {
  return {
    prompt: spendRequestPrompt(current),
    display: "confirmation" as const,
    allowFreeform: true,
    options: [
      { id: "approved", label: "I approved it in Link", style: "primary" as const },
      { id: "cancel", label: "Cancel this purchase", style: "danger" as const },
    ],
  };
}

const DECLINE = /^\s*(no|nope|cancel|cancelled|canceled|stop|don'?t|do not|decline|declined|reject|rejected|never ?mind|abort)\b/i;

/**
 * What the person's answer means. "cancel" only when they said so (the button,
 * or a reply that opens with a no); every other reply, "Approve" and "done"
 * included, means "check Link", which is where the purchase is really approved.
 */
export function interpretSpendRequestAnswer(answer: { status: string; optionId?: string; text?: string }): "check" | "cancel" {
  if (answer.status !== "answered" || answer.optionId === "cancel") return "cancel";
  if (answer.optionId) return "check";
  return DECLINE.test(answer.text ?? "") ? "cancel" : "check";
}

export const APPROVE_SPEND_REQUEST_DESCRIPTION =
  "Put a spend request in front of the person for approval and wait for their answer. Call this right after create_spend_request. It shows them the merchant, the total and the Link approval button, pauses until they confirm or cancel, then returns the request's real status from Link. Only proceed to pay_on_computer when it returns approved.";
