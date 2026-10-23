import { parseCard } from "./parse.js";
import type { Card } from "./types.js";

/**
 * Questions that carry a card.
 *
 * eve's question has a prompt and options, nothing else. So a Kybernesis tool
 * that wants a client to draw something richer than buttons puts a marker on
 * the prompt's first line, `[kyb:<name>] {json}`, and the plain question after
 * it. A Kybernesis client draws the card; every other surface should show only
 * the sentence. `[kyb:card]` carries a card envelope; the older
 * `[kyb:vault-item]` and `[kyb:spend-request]` markers carry their own shapes
 * and keep working.
 */

export const CARD_MARKER = "[kyb:card]";
export const VAULT_ITEM_MARKER = "[kyb:vault-item]";
export const SPEND_REQUEST_MARKER = "[kyb:spend-request]";

const MARKER_LINE = /^\[kyb:([a-z][a-z0-9-]{0,39})\][^\n]*(?:\n|$)/;

/** A marked prompt, split into the marker's name, its JSON payload, and the sentence for people. */
export interface MarkedPrompt {
  marker: string;
  payload: unknown;
  text: string;
}

/** The marker on a prompt's first line, or null when there is none or its JSON does not parse. */
export function parseMarkedPrompt(prompt: string): MarkedPrompt | null {
  const m = MARKER_LINE.exec(prompt);
  if (!m) return null;
  const head = m[0].replace(/\n$/, "");
  const json = head.slice(head.indexOf("]") + 1).trim();
  try {
    return { marker: m[1]!, payload: json ? JSON.parse(json) : null, text: prompt.slice(m[0].length).trim() };
  } catch {
    return null;
  }
}

/**
 * The prompt as a person should read it on a text-only channel.
 *
 * Drops a `[kyb:…]` marker line whether or not its JSON parses: a half-written
 * marker is still not something to show a person. A prompt that is nothing
 * but a marker keeps its marker rather than becoming empty.
 */
export function promptText(prompt: string): string {
  const m = MARKER_LINE.exec(prompt);
  if (!m) return prompt;
  const rest = prompt.slice(m[0].length).trim();
  return rest || prompt;
}

/** The card a `[kyb:card]` question carries, with its sentence. */
export function parseCardPrompt(prompt: string): { card: Card; text: string } | null {
  const marked = parseMarkedPrompt(prompt);
  if (!marked || marked.marker !== "card") return null;
  const card = parseCard(marked.payload);
  return card ? { card, text: marked.text } : null;
}

/** A question prompt carrying a card, for a tool to pass to `ctx.ask`. */
export function cardPrompt(card: Card, sentence: string): string {
  return `${CARD_MARKER} ${JSON.stringify(card)}\n${sentence.trim()}`;
}
