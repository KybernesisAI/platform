/**
 * Keep one tool result from filling the model's context.
 *
 * A connector returns whatever the service returns, and services are generous:
 * a mail search answers with every message's full HTML, headers and encoded
 * attachments. One such call reached 2.2M tokens against a 1M window, and the
 * conversation could not recover, because every later turn re-sent it. eve
 * measures new history as characters / 4 before it asks the provider, which
 * undercounts encoded or markup-heavy text by two or three times, so its own
 * compaction did not see it coming. The only reliable place to bound a result
 * is before it enters the conversation.
 *
 * The order matters. Encoded blobs go first: they cost the most tokens and a
 * model can do nothing with them. Long strings are shortened next, evenly, so
 * ten emails keep ten openings rather than one whole body. Long lists keep
 * their first items. Only if all that is still too much is the serialized
 * result cut, with a note telling the model how to ask for less.
 */

/** Default bound, in characters of serialized JSON (roughly 15–30k tokens). */
export const DEFAULT_MAX_RESULT_CHARS = 60_000;

const MIN_STRING_CHARS = 500;
const MIN_LIST_ITEMS = 5;
const ENCODED = /^[A-Za-z0-9+/=_\-\r\n]+$/;

function size(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Base64 (or base64url) data: long, no spaces, nothing but the alphabet. */
function isEncoded(text: string): boolean {
  return text.length >= 1_000 && ENCODED.test(text.slice(0, 4_000));
}

function walk(value: unknown, onString: (s: string) => unknown, onList: (a: unknown[]) => unknown[]): unknown {
  if (typeof value === "string") return onString(value);
  if (Array.isArray(value)) return onList(value).map((v) => walk(v, onString, onList));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, onString, onList);
    return out;
  }
  return value;
}

const keepLists = (a: unknown[]) => a;
const keepStrings = (s: string) => s;

/**
 * The result, or a smaller version of it that serializes to at most
 * `maxChars` characters. Small results come back untouched (same reference).
 */
export function boundResult(value: unknown, maxChars = DEFAULT_MAX_RESULT_CHARS): unknown {
  const original = size(value);
  if (original <= maxChars) return value;

  // 1. Encoded data: never useful to a model, often most of the payload.
  let current = walk(
    value,
    (s) => (isEncoded(s) ? `[${s.length} characters of encoded data omitted]` : s),
    keepLists,
  );

  // 2. Long strings, shortened evenly, halving until it fits.
  for (let limit = Math.floor(maxChars / 2); size(current) > maxChars && limit >= MIN_STRING_CHARS; limit = Math.floor(limit / 2)) {
    current = walk(
      current,
      (s) => (s.length > limit ? `${s.slice(0, limit)}… [${s.length - limit} more characters cut]` : s),
      keepLists,
    );
  }

  // 3. Long lists keep their first items.
  for (let items = 50; size(current) > maxChars && items >= MIN_LIST_ITEMS; items = Math.floor(items / 2)) {
    current = walk(
      current,
      keepStrings,
      (a) => (a.length > items ? [...a.slice(0, items), `[${a.length - items} more items cut]`] : a),
    );
  }

  const note =
    `[Result shortened from ${original} to about ${maxChars} characters so the conversation stays ` +
    `within the model's limits. If something you need is missing, ask for fewer items, a narrower ` +
    `search, or one item by its id.]`;

  // 4. Still too big: cut the serialized form.
  const serialized = JSON.stringify(current) ?? "";
  if (serialized.length > maxChars) {
    return `${note}\n\n${serialized.slice(0, Math.max(0, maxChars - note.length - 2))}`;
  }
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return { _note: note, ...(current as Record<string, unknown>) };
  }
  return { _note: note, result: current };
}
