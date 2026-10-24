import { parseCard } from "./parse.js";
import { cardText } from "./text.js";
import type { Card } from "./types.js";

/**
 * Cards carried inside chat text, for channels that only carry text.
 *
 * A bridge never gets to attach data to a chat message, only words. So it puts
 * the card in an HTML comment after its fallback text:
 *
 *     Revenue is up 8% this week.
 *
 *     <!-- kyb:card v1 {"kyb":1,"card":"stats",...} -->
 *
 * Markdown chat clients hide complete comments, so people see only the text; a
 * client that knows the marker draws the card instead. The JSON never contains
 * `--`, so the comment cannot close early.
 */

export const HIDDEN_CARD_OPEN = "<!-- kyb:card v1 ";
const HIDDEN_CARD = /<!-- kyb:card v1 (\{[\s\S]*?\}) -->/g;

/** Past this many characters a card travels as its text alone. */
export const HIDDEN_CARD_MAX = 16_000;

/** The comment that carries `card`, or null when it is too large to carry. */
export function hiddenCard(card: Card): string | null {
  // `--` only ever appears inside a JSON string, where `-` reads back as `-`.
  const json = JSON.stringify(card).replace(/--/g, "-\\u002d");
  if (json.length > HIDDEN_CARD_MAX) return null;
  return `${HIDDEN_CARD_OPEN}${json} -->`;
}

/**
 * One chat message for `card`: its fallback text, then the hidden card.
 * Null when the card has no text to show, since a person without a card-aware
 * client would see an empty message.
 */
export function cardMessage(card: Card): string | null {
  const text = cardText(card).trim();
  if (!text) return null;
  const hidden = hiddenCard(card);
  return hidden ? `${text}\n\n${hidden}` : text;
}

/** Every card hidden in `content`, in order. Comments that are not valid cards are skipped. */
export function readHiddenCards(content: string): Card[] {
  if (!content.includes(HIDDEN_CARD_OPEN)) return [];
  const out: Card[] = [];
  for (const m of content.matchAll(HIDDEN_CARD)) {
    try {
      const card = parseCard(JSON.parse(m[1]!));
      if (card) out.push(card);
    } catch {
      // Not ours, or damaged in transit: the text around it still reads.
    }
  }
  return out;
}

/** `content` with every hidden card removed, for surfaces that show raw text. */
export function withoutHiddenCards(content: string): string {
  return content.replace(HIDDEN_CARD, "").replace(/\n{3,}/g, "\n\n").trim();
}
