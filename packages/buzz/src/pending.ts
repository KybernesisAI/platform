import type { Client, InputRequest, MessageStreamEvent } from "eve/client";
import type { StoredSession } from "./sessions.js";

export interface FollowPendingOptions {
  client: Client;
  session: StoredSession;
  signal: AbortSignal;
  onProgress: (value: { streamIndex: number; pending: readonly InputRequest[] }) => void | Promise<void>;
  onPrompt: (requests: readonly InputRequest[]) => void | Promise<void>;
  onMessage: (message: string) => void | Promise<void>;
  onFailed?: (message: string) => void | Promise<void>;
}

/**
 * Follow one parked session from its durable cursor until it resumes or fails.
 *
 * Progress is persisted before external delivery. That ordering prevents a
 * restarted bridge from posting the same durable completion a second time.
 */
export async function followPendingSession(options: FollowPendingOptions): Promise<"settled" | "aborted" | "ended"> {
  const handle = options.client.sessions.attach(options.session.id, {
    streamIndex: options.session.streamIndex,
  });
  let streamIndex = options.session.streamIndex;
  let pending = options.session.pending ?? [];
  let message = "";

  try {
    for await (const event of handle.stream({
      startIndex: options.session.streamIndex,
      follow: true,
      signal: options.signal,
    })) {
      streamIndex += 1;
      const prompt = applyEvent(event, pending);
      if (prompt !== undefined) {
        pending = prompt;
        await options.onProgress({ streamIndex, pending });
        await options.onPrompt(pending);
        continue;
      }
      if (event.type === "input.resolved" || event.type === "turn.started") pending = [];
      if (event.type === "message.completed" && event.data.message) message = event.data.message;

      await options.onProgress({ streamIndex, pending });

      if (event.type === "session.failed") {
        await options.onFailed?.(event.data.message);
        return "settled";
      }
      if (event.type === "session.completed" || event.type === "session.waiting") {
        if (pending.length > 0) continue;
        if (message) await options.onMessage(message);
        return "settled";
      }
    }
    return options.signal.aborted ? "aborted" : "ended";
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
    throw error;
  }
}

function applyEvent(
  event: MessageStreamEvent,
  current: readonly InputRequest[],
): readonly InputRequest[] | undefined {
  if (event.type !== "input.requested") return undefined;
  if (sameRequests(current, event.data.requests)) return undefined;
  return event.data.requests;
}

function sameRequests(a: readonly InputRequest[], b: readonly InputRequest[]): boolean {
  return a.length === b.length && a.every((request, index) => request.requestId === b[index]?.requestId);
}
