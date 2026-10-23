import { CARD_VERSION, type Card, type CardAction, type CardDataByType, type KnownCardType } from "./types.js";
import { cardText } from "./text.js";

/**
 * Making cards, for tool authors.
 *
 * A tool returns its normal output with the cards under `kyb`, and passes
 * `forModel` to eve's `toModelOutput` so the model reads the output without
 * the card data, plus one line saying what the person was shown. eve still
 * puts the full output on `action.result`, which is where clients find the
 * cards, so the model's context does not pay for a table it already wrote.
 */

export interface CardFields {
  id?: string;
  title?: string;
  source?: string;
  actions?: CardAction[];
  text?: string;
}

/** A card of a known type, with its plain-text fallback filled in when none is given. */
export function card<T extends KnownCardType>(type: T, data: CardDataByType[T], fields: CardFields = {}): Card {
  const made = { kyb: CARD_VERSION, card: type, data, ...fields } as Card;
  return { ...made, text: fields.text ?? cardText(made) };
}

/** A tool output carrying cards. */
export function withCards<T extends Record<string, unknown>>(output: T, ...cards: Card[]): T & { kyb: Card | Card[] } {
  return { ...output, kyb: cards.length === 1 ? cards[0]! : cards };
}

/**
 * What the model should read from an output that carries cards: the output
 * without them, and a note naming what the person now sees, so the model
 * does not repeat the card's contents in its reply.
 */
export function forModel(output: unknown): { type: "json"; value: unknown } {
  if (typeof output !== "object" || output === null || Array.isArray(output) || !("kyb" in output)) {
    return { type: "json", value: output ?? null };
  }
  const { kyb, ...rest } = output as Record<string, unknown>;
  const cards = (Array.isArray(kyb) ? kyb : [kyb]) as Card[];
  const shown = cards.map((c) => `${c.card}${c.title ? ` "${c.title}"` : ""}`).join(", ");
  return { type: "json", value: { ...rest, shownToPerson: `The person sees this as a card: ${shown}. Refer to it; do not repeat its contents.` } };
}
