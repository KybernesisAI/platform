/**
 * Reading an eve session stream in either of its two formats.
 *
 * eve 0.69 to 0.83 serve stream version 26: one event per NDJSON line,
 * `{type, data, meta}`. eve 1.0 serves version 27 (`x-eve-stream-version: 27`):
 * each stored line is an event line `{at, facts: [...]}` holding every event
 * one state change produced, or a progress record `{progress: {...}}` for
 * streamed text and tool input. Transport records (`{"$eve": "heartbeat"}`)
 * are neither.
 *
 * Kybernesis clients meet both for weeks: a customer's agent stays on 0.81
 * until its owner presses Update. So readers turn each line into events with
 * `streamEvents` and ask the questions they care about (is this the reply,
 * did the turn end, is it waiting on a person) through the helpers here, which
 * answer for both formats. Cursors count stored lines in v27 and events in
 * v26; since v26 stores one event per line, "non-transport lines read" is the
 * cursor in both.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export interface StreamEvent {
  type: string;
  data?: unknown;
  /** v27: the turn, run or task the event belongs to. */
  scope?: { turnId?: string; runId?: string; taskId?: string };
  meta?: { at?: string; position?: { line: number; index: number }; endOfLine?: boolean; [key: string]: unknown };
}

/** A transport record: not a stored line, so it does not move the cursor. */
export function isTransportRecord(record: unknown): boolean {
  return isObj(record) && typeof record.$eve === "string";
}

/** Which format a parsed line is in, or null for a transport record or something else. */
export function lineFormat(record: unknown): 26 | 27 | null {
  if (!isObj(record) || isTransportRecord(record)) return null;
  if (Array.isArray(record.facts) || isObj(record.progress)) return 27;
  if (typeof record.type === "string") return 26;
  return null;
}

/**
 * The events in one parsed NDJSON line, in order. `line` is the stored line's
 * position, when the reader counts them; v27 events get `meta.position` from
 * it, and keep any `meta` the server sent.
 */
export function streamEvents(record: unknown, line?: number): StreamEvent[] {
  if (!isObj(record) || isTransportRecord(record)) return [];
  if (Array.isArray(record.facts)) {
    const at = str(record.at);
    const facts = record.facts.filter(isObj);
    return facts.map((fact, index) => ({
      ...(fact as unknown as StreamEvent),
      meta: {
        ...(at ? { at } : {}),
        ...(line !== undefined ? { position: { line, index } } : {}),
        ...(index < facts.length - 1 ? { endOfLine: false } : {}),
        ...(isObj(fact.meta) ? fact.meta : {}),
      },
    }));
  }
  if (isObj(record.progress)) {
    const progress = record.progress;
    return [
      {
        ...(progress as unknown as StreamEvent),
        meta: { ...(line !== undefined ? { position: { line, index: 0 } } : {}), ...(isObj(progress.meta) ? progress.meta : {}) },
      },
    ];
  }
  if (typeof record.type === "string") return [record as unknown as StreamEvent];
  return [];
}

/** The turn an event belongs to, in either format. */
export function turnIdOf(event: StreamEvent): string | undefined {
  const data = isObj(event.data) ? event.data : {};
  return event.scope?.turnId ?? str(data.turnId);
}

/**
 * The reply text an event carries, when it is the answer and not narration:
 * v26 `message.completed` that did not end in tool calls, v27 text
 * `content.completed` in the reply phase.
 */
export function replyText(event: StreamEvent): string | undefined {
  const data = isObj(event.data) ? event.data : {};
  if (event.type === "content.completed") {
    if (data.kind !== "text" || data.phase !== "reply") return undefined;
    return str(data.value) ?? str(data.fallbackText);
  }
  if (event.type === "message.completed") {
    if (data.finishReason === "tool-calls") return undefined;
    return str(data.message);
  }
  return undefined;
}

/** Text the model said on the way (narration), in either format. */
export function narrationText(event: StreamEvent): string | undefined {
  const data = isObj(event.data) ? event.data : {};
  if (event.type === "content.completed") {
    return data.kind === "text" && data.phase !== "reply" ? str(data.value) : undefined;
  }
  if (event.type === "message.completed" && data.finishReason === "tool-calls") return str(data.message);
  return undefined;
}

export type TurnEnd = "completed" | "failed" | "cancelled";

/** How a turn ended, when this event ends one. */
export function turnEnd(event: StreamEvent): TurnEnd | undefined {
  const data = isObj(event.data) ? event.data : {};
  switch (event.type) {
    case "turn.settled": {
      const outcome = str(data.outcome);
      return outcome === "completed" || outcome === "failed" || outcome === "cancelled" ? outcome : "failed";
    }
    case "turn.completed":
      return "completed";
    case "turn.failed":
      return "failed";
    case "turn.cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

/** The error message a failed turn or session carries, in either format. */
export function failureMessage(event: StreamEvent): string | undefined {
  const data = isObj(event.data) ? event.data : {};
  const error = isObj(data.error) ? data.error : undefined;
  return str(error?.message) ?? str(data.message) ?? str(data.reason);
}

/**
 * True when the turn has stopped to wait for a person: an approval, a
 * question, a sign-in or a budget prompt. v27 `turn.paused`; v26
 * `turn.waiting` on input.
 */
export function waitsOnPerson(event: StreamEvent): boolean {
  const data = isObj(event.data) ? event.data : {};
  if (event.type === "turn.paused") return true;
  return event.type === "turn.waiting" && data.on === "input";
}

/** True when the session has gone idle or ended (v26 session.waiting/completed/failed, v27 session.ended). */
export function sessionSettled(event: StreamEvent): boolean {
  return (
    event.type === "session.ended" ||
    event.type === "session.waiting" ||
    event.type === "session.completed" ||
    event.type === "session.failed"
  );
}

export interface OpenRequest {
  /** v27 `interactionId`, v26 `requestId`: what an answer names. */
  id: string;
  kind: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowFreeform: boolean;
  /** v27 only: the child session's request this one relays. */
  origin?: unknown;
}

/** Requests for a person that this event opens (v27 `interaction.opened`, v26 `input.requested`). */
export function openedRequests(event: StreamEvent): OpenRequest[] {
  const data = isObj(event.data) ? event.data : {};
  const options = (raw: unknown): OpenRequest["options"] =>
    Array.isArray(raw)
      ? raw.filter(isObj).map((o) => ({ id: str(o.id) ?? "", label: str(o.label) ?? str(o.id) ?? "" })).filter((o) => o.id)
      : [];
  if (event.type === "interaction.opened") {
    const request = isObj(data.request) ? data.request : {};
    const id = str(data.interactionId);
    if (!id) return [];
    return [
      {
        id,
        kind: str(request.kind) ?? "question",
        prompt: str(request.prompt) ?? "",
        options: options(request.options),
        allowFreeform: request.allowFreeform === true,
        ...(data.origin !== undefined ? { origin: data.origin } : {}),
      },
    ];
  }
  if (event.type === "input.requested" && Array.isArray(data.requests)) {
    return data.requests.filter(isObj).flatMap((r) => {
      const id = str(r.requestId);
      if (!id) return [];
      return [
        {
          id,
          kind: str(r.kind) ?? "question",
          prompt: str(r.prompt) ?? "",
          options: options(r.options),
          allowFreeform: r.allowFreeform === true,
        },
      ];
    });
  }
  return [];
}

/** Ids of requests this event settles (v27 `interaction.settled`, v26 `input.resolved`). */
export function settledRequestIds(event: StreamEvent): string[] {
  const data = isObj(event.data) ? event.data : {};
  if (event.type === "interaction.settled") {
    const id = str(data.interactionId);
    return id ? [id] : [];
  }
  if (event.type === "input.resolved") {
    const ids = Array.isArray(data.requestIds) ? data.requestIds : [data.requestId];
    return ids.map(str).filter((id): id is string => Boolean(id));
  }
  return [];
}

/**
 * Answers in the v27 shape, from what an older client sends.
 *
 * Studio and the phone still post v26 `inputResponses` to the manage routes;
 * eve 1.0 takes `answers: [{interactionId, optionId, text}]`, and the deny
 * choice is `deny`, not `cancel`. Entries already in the new shape pass
 * through. Anything unrecognisable is dropped.
 */
export interface Answer {
  interactionId: string;
  optionId?: string;
  text?: string;
}

export function toAnswers(raw: unknown): Answer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).flatMap((r) => {
    // v26 InputResponse is {requestId, optionId?, text?}; v27 Answer is {interactionId, optionId?, text?}.
    const interactionId = str(r.interactionId) ?? str(r.requestId);
    if (!interactionId) return [];
    let optionId = str(r.optionId);
    if (optionId === "cancel") optionId = "deny";
    const text = str(r.text);
    return [{ interactionId, ...(optionId ? { optionId } : {}), ...(text !== undefined ? { text } : {}) }];
  });
}
