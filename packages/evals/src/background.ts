import type { EveEvalContext, EveEvalTurn } from "eve/evals";

/**
 * eve ≥0.63 runs every declared subagent as a durable BACKGROUND task, and a
 * remote peer (dispatch) answers the same way: the root's turn settles with
 * "I'm on it", and the real answer lands in a later turn when the child or the
 * peer reports back. A judge that reads the first turn grades the
 * acknowledgement. Follow up to `maxHops` such turns and return the last one
 * that settled; a turn with no pending work is returned as is.
 *
 * Pending work shows in two shapes: `subagent.called` without a matching
 * `subagent.completed` (declared subagents), or a tool result carrying
 * `status: "working"` (remote peers through @kybernesis/dispatch).
 */
export async function settleBackgroundWork(t: EveEvalContext, turn: EveEvalTurn, maxHops = 3): Promise<EveEvalTurn> {
  let current = turn;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!hasPendingWork(current)) return current;
    const live = t.target.watchTurn(current.sessionId, { startIndex: current.session.state.streamIndex });
    current = await live.result();
  }
  return current;
}

export function hasPendingWork(turn: EveEvalTurn): boolean {
  const delegated = turn.events.some((event) => event.type === "subagent.called");
  const reported = turn.events.some((event) => event.type === "subagent.completed");
  if (delegated && !reported) return true;
  return turn.toolCalls.some((call) => {
    const output = call.output;
    return typeof output === "object" && output !== null && !Array.isArray(output) && (output as { status?: unknown }).status === "working";
  });
}
