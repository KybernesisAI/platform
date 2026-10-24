import {
  parseInputResponses,
  resolveTextToResponses,
  type ClientSession,
  type InputRequest,
  type InputResponse,
  type MessageStreamEvent,
} from "eve/client";
import { askFrom, askText, cardsOf, hiddenAsk, newStepState, readStep, type AskAnswer, type Card } from "@kybernesis/cards";
import type { StoredSession } from "./sessions.js";

/**
 * Render pending Eve input in a Buzz channel.
 *
 * Everyone reads the words: a question's sentence (a `[kyb:…]` marker line is
 * dropped), an approval as the email or event it would send, then the options
 * by number. With `carry`, each question also travels hidden after the words
 * (`<!-- kyb:ask v1 … -->`), so the Kybernesis plugin can draw it the way
 * Studio does and answer it with a press. Only a posted prompt carries them:
 * a press is accepted only as a reply to a prompt the bridge is watching.
 */
export function formatInputRequests(requests: readonly InputRequest[], options: { carry?: boolean } = {}): string {
  const asks = requests.map((request) => askFrom(request));
  const text = asks.map((ask, requestIndex) => {
    const request = requests[requestIndex]!;
    const prompt = askText(ask);
    const lines = [
      requests.length > 1 ? `Question ${requestIndex + 1}: ${prompt}` : prompt,
    ];
    if (request.options?.length) {
      lines.push(
        "",
        ...request.options.map((option, optionIndex) => {
          const description = option.description ? ` — ${option.description}` : "";
          return `${optionIndex + 1}. ${option.label} [${option.id}]${description}`;
        }),
      );
    }
    if (request.allowFreeform === true || !request.options?.length) {
      lines.push("", "Reply to this message with an option number, option ID, exact label, or your own answer.");
    } else {
      lines.push("", "Reply to this message with an option number, option ID, or exact label.");
    }
    return lines.join("\n");
  }).join("\n\n");
  if (!options.carry) return text;
  const hidden = asks.map((ask) => hiddenAsk(ask)).filter((h): h is string => h !== null);
  return hidden.length ? `${text}\n\n${hidden.join("\n")}` : text;
}

/**
 * Answers a client pressed, checked against what is actually open.
 *
 * Each answer must name an open request. An option must be one of that
 * request's own; words alone answer only a question that takes words. eve's
 * strict schema checks the result before it is sent. `stale` is true when no
 * answer named an open request, which is what a second press on a question
 * someone already answered looks like.
 */
export function resolveCarriedAnswers(
  answers: readonly AskAnswer[],
  requests: readonly InputRequest[],
): { responses: readonly InputResponse[]; stale: false } | { responses: null; stale: boolean } {
  const open = new Map(requests.map((request) => [request.requestId, request]));
  const picked = new Map<string, InputResponse>();
  let named = false;
  for (const answer of answers) {
    const request = open.get(answer.requestId);
    if (!request) continue;
    named = true;
    if (picked.has(request.requestId)) continue;
    const ids = request.options?.map((option) => option.id) ?? [];
    if (answer.optionId !== undefined) {
      if (ids.length > 0 && !ids.includes(answer.optionId)) return { responses: null, stale: false };
      picked.set(request.requestId, {
        requestId: request.requestId,
        optionId: answer.optionId,
        ...(answer.text?.trim() ? { text: answer.text.trim() } : {}),
      } as InputResponse);
      continue;
    }
    const words = answer.text?.trim();
    if (!words || (ids.length > 0 && request.allowFreeform !== true)) return { responses: null, stale: false };
    picked.set(request.requestId, { requestId: request.requestId, text: words } as InputResponse);
  }
  if (picked.size === 0) return { responses: null, stale: !named };
  try {
    return { responses: parseInputResponses([...picked.values()]), stale: false };
  } catch {
    return { responses: null, stale: false };
  }
}

/** What a press on a question nobody is waiting on any more gets. */
export const STALE_ANSWER_REPLY = "That question was already answered, so nothing changed.";

/** Resolve a Buzz text reply using Eve's certified matching semantics. */
export function resolveInputReply(
  text: string,
  requests: readonly InputRequest[],
): readonly InputResponse[] | null {
  if (!text.trim()) return null;
  const responses = resolveTextToResponses(text, requests);
  return responses.length === requests.length ? responses : null;
}

/** Actionable response for text that cannot satisfy every pending request. */
export function invalidInputReply(requests: readonly InputRequest[]): string {
  return `I still need a valid answer before I can continue.\n\n${formatInputRequests(requests)}`;
}

/** Submit a matched reply without consuming its response stream. */
export async function respondToPendingConversation(
  session: Pick<ClientSession, "respond">,
  responses: readonly InputResponse[],
  community: string,
  channel: string,
): Promise<void> {
  await session.respond(responses, {
    clientContext: { buzzCommunity: community, buzzChannel: channel },
    streamReconnectPolicy: { reconnect: false },
  });
}

/**
 * How long a follower waits between reattaching when it saw no progress.
 *
 * @remarks
 * The follower used to reattach on a flat one-second timer. With eve's client
 * spending about 100 s on an idle stream before giving up, that produced the
 * fixed ~110 s cycle observed in KYB-545: forever, for as long as the process
 * lived. Backing off turns a spin into a wait, and the cap keeps a genuinely
 * slow resume from being abandoned for minutes at a time.
 */
export function followerRetryDelayMs(cycles: number, capMs = 60_000): number {
  const safeCycles = Number.isFinite(cycles) ? Math.max(0, Math.trunc(cycles)) : 0;
  return Math.min(1_000 * 2 ** Math.min(safeCycles, 30), capMs);
}

/**
 * What the room is told when a resumed turn produced nothing for too long.
 *
 * @remarks
 * KYB-529's rule applied to the resumed phase: the person committed attention
 * to answering a question, so silence is the one outcome they must not get.
 * Say the answer arrived, say the work did not, and say the channel is usable.
 */
export function resumeStalledReply(stallMs: number): string {
  const minutes = Math.max(1, Math.round(stallMs / 60_000));
  return (
    `Your answer reached me, but the turn it restarted then went quiet for over ${minutes} minute` +
    `${minutes === 1 ? "" : "s"} without producing anything, so I have stopped waiting on it. ` +
    `Nothing was posted and no work landed from it. This channel is clear — ask me again and I will start fresh.`
  );
}

/** A session needs its follower while asking or while resumed output is unpublished. */
export function needsPendingFollower(session: Pick<StoredSession, "pendingInputRequests" | "resumeInFlight">): boolean {
  return Boolean(session.pendingInputRequests?.length || session.resumeInFlight);
}

export interface PendingFollowerCallbacks {
  /** Persist the latest cursor and supervision state before publishing outward. */
  onState(state: Omit<StoredSession, "updated">): void | Promise<void>;
  onInputRequested(requests: readonly InputRequest[]): void | Promise<void>;
  /** The resumed turn's words, and the cards its tools handed back. */
  onMessage(message: string, cards: readonly Card[]): void | Promise<void>;
  onLog?: (message: string) => void;
}

type MutableStoredSession = Omit<StoredSession, "updated">;

function withPending(
  state: MutableStoredSession,
  requests: readonly InputRequest[],
): MutableStoredSession {
  const { resumeInFlight: _, ...rest } = state;
  return { ...rest, pendingInputRequests: requests };
}

function withResumeInFlight(state: MutableStoredSession): MutableStoredSession {
  const { pendingInputRequests: _, ...rest } = state;
  return { ...rest, resumeInFlight: true };
}

function withoutSupervision(state: MutableStoredSession): MutableStoredSession {
  const { pendingInputRequests: _, resumeInFlight: __, ...rest } = state;
  return rest;
}

/**
 * Follow one parked conversation until it resumes, asks another HITL question,
 * or reaches a terminal/non-HITL boundary. This follower is the sole publisher
 * of resumed output; callers of `respond()` must not consume or publish its
 * response stream as well.
 *
 * The durable `resumeInFlight` marker deliberately survives `input.resolved`.
 * It is cleared only after the relay publication callback succeeds, so a crash
 * or disconnect between Eve accepting input and Buzz publishing output can
 * reattach from the persisted cursor instead of letting a normal stale drain
 * swallow the resumed answer.
 */
export async function followPendingConversation(
  session: Pick<ClientSession, "state" | "stream">,
  initial: MutableStoredSession,
  callbacks: PendingFollowerCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let state = { ...initial };
  let streamIndex = initial.streamIndex;
  let completedMessage = "";
  let steps = newStepState();

  const persist = async () => {
    state = { ...state, streamIndex };
    await callbacks.onState(state);
  };

  const publishThenClear = async () => {
    // Do not persist past message.completed/turn.completed until publication
    // succeeds. If this callback throws or the process dies, recovery replays
    // the unpublished output from the last safe cursor.
    const cards = cardsOf(steps.steps.values());
    if (completedMessage.trim() || cards.length) await callbacks.onMessage(completedMessage, cards);
    state = withoutSupervision(state);
    await persist();
  };

  for await (const event of session.stream({
    follow: true,
    startIndex: initial.streamIndex,
    signal,
  })) {
    if (signal.aborted) return;
    const streamEvent = event as MessageStreamEvent;
    // ClientSession updates its public cursor only when the async iterator
    // closes; count yielded durable events so crash recovery can persist while
    // the follower is still open.
    streamIndex += 1;
    readStep(steps, streamEvent.type, streamEvent.data);

    switch (streamEvent.type) {
      case "input.requested":
        completedMessage = "";
        steps = newStepState();
        state = withPending(state, streamEvent.data.requests);
        // Keep the durable cursor before the prompt until Buzz accepts it for
        // relay delivery; a reconnect can then replay and render the request.
        await callbacks.onInputRequested(streamEvent.data.requests);
        await persist();
        break;
      case "input.resolved": {
        const resolved = new Set(streamEvent.data.resolutions.map((resolution) => resolution.requestId));
        const remaining = state.pendingInputRequests?.filter((request) => !resolved.has(request.requestId)) ?? [];
        state = remaining.length > 0 ? withPending(state, remaining) : withResumeInFlight(state);
        await persist();
        break;
      }
      case "message.completed":
        // A resumed turn can end more than one step with prose (the answer, then a wrap-up line).
        // The room gets the whole turn, not whichever message happened to come last.
        if (streamEvent.data.finishReason !== "tool-calls" && streamEvent.data.message) {
          completedMessage = completedMessage
            ? `${completedMessage}\n\n${streamEvent.data.message}`
            : streamEvent.data.message;
        }
        // The durable cursor remains before unpublished output. A restarted
        // follower may replay this event safely because it is the sole publisher.
        break;
      case "turn.completed":
      case "session.waiting":
        if (!state.pendingInputRequests?.length) {
          await publishThenClear();
          return;
        }
        await persist();
        break;
      case "turn.cancelled":
      case "turn.failed":
      case "session.failed":
      case "session.completed":
        state = withoutSupervision(state);
        await persist();
        return;
      default:
        // Replaying progress events after a crash has no outward side effect.
        // Persist semantic boundaries rather than writing the session file for
        // every token delta.
        break;
    }
  }

  callbacks.onLog?.("pending Eve stream ended before a resumable boundary");
}
