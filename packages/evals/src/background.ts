import type { EveEvalContext, EveEvalTurn } from "eve/evals";

/**
 * eve ≥0.63 runs every declared subagent as a durable BACKGROUND task, and a
 * remote peer (dispatch) answers the same way: the root's turn settles with
 * "I'm on it", and the real answer lands in a later turn when the child or the
 * peer reports back. A judge that reads the first turn grades the
 * acknowledgement. Follow up to `maxHops` such turns and return the last one
 * that settled; a turn with no pending work is returned as is.
 *
 * eve ≥0.69 holds the turn open while its tasks work, so a declared
 * subagent's answer usually lands in the same turn. Pending work still shows
 * in two shapes: a `task.started` with no `task.settled` for the same call
 * (a turn that ended or timed out while a task worked), or a tool result
 * carrying `status: "working"` (remote peers through @kybernesis/dispatch).
 */
export async function settleBackgroundWork(
  t: EveEvalContext,
  turn: EveEvalTurn,
  options: { maxHops?: number; timeoutMs?: number } = {},
): Promise<EveEvalTurn> {
  const maxHops = options.maxHops ?? 3;
  // A remote peer answers by calling BACK into the agent's URL. An eval server
  // lives on a throwaway port no peer can reach, so that hop never lands;
  // waiting the whole eval timeout for it reads as a hang. Give it a bounded
  // wait and hand back the turn we have — the caller can see the work is
  // still pending (hasPendingWork) and judge accordingly.
  const timeoutMs = options.timeoutMs ?? 90_000;
  let current = turn;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!hasPendingWork(current)) return current;
    const live = t.target.watchTurn(current.sessionId, { startIndex: current.session.state.streamIndex });
    const next = await Promise.race([
      live.result(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (next === null) return current;
    current = next;
  }
  return current;
}

export function hasPendingWork(turn: EveEvalTurn): boolean {
  const settled = new Set<unknown>();
  for (const event of turn.events) if (event.type === "task.settled") settled.add(event.data.callId);
  const unsettled = turn.events.some((event) => event.type === "task.started" && !settled.has(event.data.callId));
  if (unsettled) return true;
  return turn.toolCalls.some((call) => {
    const output = call.output;
    return typeof output === "object" && output !== null && !Array.isArray(output) && (output as { status?: unknown }).status === "working";
  });
}
