/**
 * Whether a conversation is waiting on an answer from the person.
 *
 * Routines deliver into the agent's canonical conversation, which is the same
 * one the person types in. That is the point — it is how a routine's answer
 * reaches them. It also creates a hazard that is worse than a routine not
 * running at all.
 *
 * eve resolves a pending `question` batch with the NEXT message that arrives in
 * the session. When that message is a person's reply, that is exactly right.
 * When it is a routine firing on a timer, the routine's own prompt is recorded
 * as the person's answer, and the agent proceeds as though they had consented.
 * A routine that asks "ship this draft?" gets a yes nobody gave.
 *
 * So a routine must not speak into a conversation that is waiting on the
 * person. It is better for a reminder to be skipped than for a question to be
 * answered by a machine on the asker's behalf.
 */

/** The fields this needs from an eve stream event; deliberately loose, the stream carries much more. */
export interface StreamEventLike {
  type?: unknown;
  batchId?: unknown;
  data?: { batchId?: unknown } | unknown;
}

function batchIdOf(event: StreamEventLike): string | undefined {
  if (typeof event.batchId === "string") return event.batchId;
  const data = event.data as { batchId?: unknown } | undefined;
  return data && typeof data.batchId === "string" ? data.batchId : undefined;
}

/**
 * Scan session events oldest-to-newest and report whether a question is still
 * outstanding.
 *
 * Pairs `input.requested` with `input.resolved` by batch id, and falls back to
 * a plain count when a batch carries no id — an unpaired request is the whole
 * signal, so losing the id must not mean losing the guard.
 */
export function awaitingPerson(events: readonly StreamEventLike[]): boolean {
  const open = new Set<string>();
  let anonymousOpen = 0;
  for (const event of events) {
    const id = batchIdOf(event);
    if (event.type === "input.requested") {
      if (id === undefined) anonymousOpen += 1;
      else open.add(id);
    } else if (event.type === "input.resolved") {
      if (id === undefined) anonymousOpen = Math.max(0, anonymousOpen - 1);
      else open.delete(id);
    }
  }
  return open.size > 0 || anonymousOpen > 0;
}

/** How far back to look. A question older than this is not one anybody is still waiting on. */
export const AWAITING_SCAN_EVENTS = 400;

/**
 * Read the tail of a session's event stream and decide whether it is parked.
 *
 * Any failure answers `false`: a routine that cannot read the stream should
 * still deliver, because silently dropping every routine is a worse failure
 * than the one this guards against.
 */
export async function sessionAwaitingPerson(session: {
  getStreamTailIndex(): Promise<number>;
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<unknown>>;
}): Promise<boolean> {
  try {
    const tail = await session.getStreamTailIndex();
    const start = Math.max(0, tail - AWAITING_SCAN_EVENTS);
    const stream = await session.getEventStream({ startIndex: start });
    const events: StreamEventLike[] = [];
    const reader = stream.getReader();
    try {
      // Bounded: the stream stays open on a live session, so this reads the
      // durable tail and stops rather than waiting for the next event forever.
      while (events.length <= AWAITING_SCAN_EVENTS) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(value as StreamEventLike);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return awaitingPerson(events);
  } catch {
    return false;
  }
}
