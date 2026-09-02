import {
  resolveTextToResponses,
  type ClientSession,
  type InputRequest,
  type InputResponse,
  type MessageStreamEvent,
} from "eve/client";
import type { StoredSession } from "./sessions.js";

/** Render pending Eve input in a text-only Buzz channel. */
export function formatInputRequests(requests: readonly InputRequest[]): string {
  return requests.map((request, requestIndex) => {
    const lines = [
      requests.length > 1 ? `Question ${requestIndex + 1}: ${request.prompt}` : request.prompt,
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
}

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

/** A session needs its follower while asking or while resumed output is unpublished. */
export function needsPendingFollower(session: Pick<StoredSession, "pendingInputRequests" | "resumeInFlight">): boolean {
  return Boolean(session.pendingInputRequests?.length || session.resumeInFlight);
}

export interface PendingFollowerCallbacks {
  /** Persist the latest cursor and supervision state before publishing outward. */
  onState(state: Omit<StoredSession, "updated">): void | Promise<void>;
  onInputRequested(requests: readonly InputRequest[]): void | Promise<void>;
  onMessage(message: string): void | Promise<void>;
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

  const persist = async () => {
    state = { ...state, streamIndex };
    await callbacks.onState(state);
  };

  const publishThenClear = async () => {
    // Do not persist past message.completed/turn.completed until publication
    // succeeds. If this callback throws or the process dies, recovery replays
    // the unpublished output from the last safe cursor.
    if (completedMessage.trim()) await callbacks.onMessage(completedMessage);
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

    switch (streamEvent.type) {
      case "input.requested":
        completedMessage = "";
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
        if (streamEvent.data.finishReason !== "tool-calls" && streamEvent.data.message) {
          completedMessage = streamEvent.data.message;
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
