import type { VaultKind } from "./client.js";

/**
 * A structured question a client can render as a form.
 *
 * eve's `ctx.ask` carries a prompt and options; nothing else. So the first
 * line of the prompt is a marker a Kybernesis client recognises
 * (`[kyb:vault-item] {json}`) and the rest is the plain question every other
 * surface shows. Studio draws a form and answers with the saved item's id;
 * iMessage shows the text and two buttons. The secret never reaches this
 * tool: the client stores it in the control plane itself and hands back an id.
 */
export const VAULT_ITEM_MARKER = "[kyb:vault-item]";

export interface VaultItemAsk {
  readonly kind: VaultKind;
  readonly site?: string;
  readonly label?: string;
  readonly reason?: string;
  /** Which fields the page wants, when the agent can tell (e.g. ["username","password"] or ["number","cvc","expiration","name"]). */
  readonly fields?: readonly string[];
}

export function vaultItemPrompt(ask: VaultItemAsk): string {
  const what = ask.kind === "login" ? "a login" : ask.kind === "card" ? "a card" : ask.kind === "address" ? "an address" : "contact details";
  const where = ask.site ? ` for ${ask.site}` : "";
  const why = ask.reason ? ` ${ask.reason.trim().replace(/\.?$/, ".")}` : "";
  return `${VAULT_ITEM_MARKER} ${JSON.stringify(ask)}\nI need ${what}${where} and there is nothing in your vault for it.${why} Add it to your vault and I will use it without seeing it, or take over my screen and type it yourself.`;
}

/** The marker's payload, if a prompt carries one. Clients call this. */
export function parseVaultItemPrompt(prompt: string): { ask: VaultItemAsk; text: string } | null {
  if (!prompt.startsWith(VAULT_ITEM_MARKER)) return null;
  const nl = prompt.indexOf("\n");
  const head = nl === -1 ? prompt : prompt.slice(0, nl);
  try {
    const ask = JSON.parse(head.slice(VAULT_ITEM_MARKER.length).trim()) as VaultItemAsk;
    return { ask, text: nl === -1 ? "" : prompt.slice(nl + 1) };
  } catch {
    return null;
  }
}

/** A client that saved the item answers with this; the tool reads the id out of it. */
export const SAVED_PREFIX = "vault:";
export function savedAnswer(itemId: string): string {
  return `${SAVED_PREFIX}${itemId}`;
}

export type VaultRequestOutcome =
  | { status: "saved"; item_id: string; note: string }
  | { status: "manual"; note: string }
  | { status: "cancelled"; note: string }
  | { status: "unavailable"; note: string };

/** What the agent's tool file passes to `ctx.ask`. The tool itself must be authored in `agent/tools/` — eve compiles `"use workflow"` from source, so a package cannot ship it. */
export function vaultItemAsk(input: VaultItemAsk) {
  return {
    prompt: vaultItemPrompt(input),
    display: "select" as const,
    allowFreeform: true,
    options: [
      { id: "manual", label: "I'll type it myself on your screen" },
      { id: "cancel", label: "Cancel", style: "danger" as const },
    ],
  };
}

/** Turn the person's answer into the tool's result. */
export function interpretVaultAnswer(answer: { status: string; optionId?: string; text?: string }): VaultRequestOutcome {
  if (answer.status === "unavailable") return { status: "unavailable", note: "No one can answer here (an unattended run). Stop and say what you need." };
  if (answer.status === "dismissed" || answer.optionId === "cancel") return { status: "cancelled", note: "The person cancelled. Do not try another way to get these details." };
  if (answer.optionId === "manual") return { status: "manual", note: "The person will type it on your screen. Take a screenshot every ~20 seconds until the form is filled or the page changes, then continue; do not touch the fields." };
  const text = (answer.text ?? "").trim();
  if (text.startsWith(SAVED_PREFIX)) {
    const id = text.slice(SAVED_PREFIX.length).trim();
    return { status: "saved", item_id: id, note: `Saved to the vault as ${id}. Call fill_from_vault with this id and the field selectors.` };
  }
  return { status: "cancelled", note: text ? `The person replied: ${text.slice(0, 200)}` : "No usable answer." };
}

export const REQUEST_VAULT_ITEM_DESCRIPTION =
  "Ask the person for a login, card, address or contact you need but could not find in their vault (use list_vault first). The turn pauses until they answer. They can add it to the vault (you get an item id to use with fill_from_vault), take over your screen to type it themselves, or cancel. Never ask for secrets in chat; use this.";
