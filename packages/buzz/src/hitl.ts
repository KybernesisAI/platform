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
      lines.push("", "Reply with an option number, option ID, exact label, or your own answer.");
    } else {
      lines.push("", "Reply with an option number, option ID, or exact label.");
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

export interface PendingFollowerCallbacks {
  /** Persist the latest cursor and pending request set before publishing outward. */
  onState(state: Omit<StoredSession, "updated">): void;
  onInputRequested(requests: readonly InputRequest[]): void | Promise<void>;
  onMessage(message: string): void | Promise<void>;
  onLog?: (message: string) => void;
}

function withoutPending(state: Omit<StoredSession, "updated">): Omit<StoredSession, "updated"> {
  const { pendingInputRequests: _, ...rest } = state;
  return rest;
}

/**
 * Follow one parked conversation until it resumes, asks another HITL question,
 * or reaches a terminal/non-HITL boundary. This follower is the sole publisher
 * of resumed output; callers of `respond()` must not consume or publish its
 * response stream as well.
 */
export async function followPendingConversation(
  session: Pick<ClientSession, "state" | "stream">,
  initial: Omit<StoredSession, "updated">,
  callbacks: PendingFollowerCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let state = { ...initial };
  let streamIndex = initial.streamIndex;
  let completedMessage = "";
  let published = false;

  const persist = (pending: readonly InputRequest[] | undefined = state.pendingInputRequests) => {
    state = {
      ...state,
      streamIndex,
      ...(pending?.length ? { pendingInputRequests: pending } : {}),
    };
    if (!pending?.length) state = withoutPending(state);
    callbacks.onState(state);
  };

  const publish = async () => {
    if (published || !completedMessage.trim()) return;
    published = true;
    await callbacks.onMessage(completedMessage);
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
        persist(streamEvent.data.requests);
        await callbacks.onInputRequested(streamEvent.data.requests);
        break;
      case "input.resolved": {
        const resolved = new Set(streamEvent.data.resolutions.map((resolution) => resolution.requestId));
        const remaining = state.pendingInputRequests?.filter((request) => !resolved.has(request.requestId));
        persist(remaining);
        break;
      }
      case "message.completed":
        if (streamEvent.data.finishReason !== "tool-calls" && streamEvent.data.message) {
          completedMessage = streamEvent.data.message;
        }
        persist();
        break;
      case "turn.completed":
        persist();
        if (!state.pendingInputRequests?.length) {
          await publish();
          return;
        }
        break;
      case "session.waiting":
        persist();
        if (!state.pendingInputRequests?.length) {
          await publish();
          return;
        }
        break;
      case "turn.cancelled":
      case "turn.failed":
      case "session.failed":
      case "session.completed":
        state = withoutPending({ ...state, streamIndex });
        callbacks.onState(state);
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
