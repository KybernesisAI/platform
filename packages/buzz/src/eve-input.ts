/**
 * Questions and answers between the bridge and eve, in the bridge's own shape.
 *
 * eve 0.81 called a question an `InputRequest` (`requestId`) and an answer an
 * `InputResponse`; eve 1.0 calls them interactions (`interactionId`) and
 * answers. The bridge keeps the `requestId` shape it has always stored, so
 * conversations on record, the prompts it rewrites and the carried cards all
 * read the same, and turns it into eve's shape only at the moment it answers.
 */
import type { OpenRequest } from "@kybernesis/cards";

/** One question the agent asked, as the bridge stores and posts it. */
export interface InputRequest {
  requestId: string;
  kind?: string;
  prompt: string;
  options?: readonly { id: string; label: string; description?: string; style?: string }[];
  allowFreeform?: boolean;
  /** The tool an approval asks about. */
  action?: { toolName?: string; input?: unknown };
}

/** One answer, as the bridge resolves it. */
export interface InputResponse {
  requestId: string;
  optionId?: string;
  text?: string;
}

/** What eve 1.0 takes as an answer. */
export interface EveAnswer {
  interactionId: string;
  optionId?: string;
  text?: string;
}

/** A question the stream opened, in the bridge's shape. */
export function inputRequestFrom(request: OpenRequest): InputRequest {
  return {
    requestId: request.id,
    kind: request.kind,
    prompt: request.prompt,
    ...(request.options.length ? { options: request.options } : {}),
    ...(request.allowFreeform ? { allowFreeform: true } : {}),
    ...(request.action ? { action: request.action } : {}),
  };
}

/** Answers in eve 1.0's shape. */
export function toEveAnswers(responses: readonly InputResponse[]): EveAnswer[] {
  return responses.map((r) => ({
    interactionId: r.requestId,
    ...(r.optionId !== undefined ? { optionId: r.optionId } : {}),
    ...(r.text !== undefined ? { text: r.text } : {}),
  }));
}

/** Answers checked for shape: each names a request and says something. Throws on anything else. */
export function parseInputResponses(raw: unknown): InputResponse[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("answers must be a non-empty list");
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.requestId !== "string" || !o.requestId) throw new Error("an answer must name its request");
    const optionId = typeof o.optionId === "string" && o.optionId ? o.optionId : undefined;
    const text = typeof o.text === "string" ? o.text : undefined;
    if (optionId === undefined && (text === undefined || !text.trim())) throw new Error("an answer must pick an option or say something");
    return { requestId: o.requestId, ...(optionId !== undefined ? { optionId } : {}), ...(text !== undefined ? { text } : {}) };
  });
}

function matchOption(lower: string, options: NonNullable<InputRequest["options"]>) {
  const byId = options.find((o) => o.id.toLowerCase() === lower);
  if (byId) return byId;
  const byLabel = options.find((o) => o.label.toLowerCase() === lower);
  if (byLabel) return byLabel;
  const n = Number(lower);
  if (Number.isInteger(n) && n > 0 && n <= options.length) return options[n - 1];
  return undefined;
}

/**
 * A typed reply as an answer to one request: an option by id, exact label or
 * number, or the words themselves when the request takes words. The rule eve
 * 0.81's client applied, kept so people answer the way they always have.
 */
export function resolveTextToResponse(text: string, request: InputRequest): InputResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (request.options?.length) {
    const option = matchOption(trimmed.toLowerCase(), request.options);
    if (option) return { requestId: request.requestId, optionId: option.id };
  }
  if (request.allowFreeform === true || !request.options?.length) return { requestId: request.requestId, text: trimmed };
  return undefined;
}

export function resolveTextToResponses(text: string, requests: readonly InputRequest[]): InputResponse[] {
  return requests.flatMap((request) => {
    const response = resolveTextToResponse(text, request);
    return response ? [response] : [];
  });
}

/**
 * Where to resume reading after an event: the same line while more of it
 * remains (a line holds every event one change produced), otherwise the next.
 * eve 1.0 counts stored lines, not events.
 */
export function cursorAfter(event: { meta?: { position?: { line?: number }; endOfLine?: boolean; next?: number } }, fallback: number): number {
  const line = event.meta?.position?.line;
  if (typeof line !== "number") return fallback + 1;
  if (event.meta?.endOfLine === false) return line;
  return typeof event.meta?.next === "number" ? event.meta.next : line + 1;
}
