import type { EveEvalContext, EveEvalTurn } from "eve/evals";

/**
 * eve ≥0.63 runs every declared subagent as a durable BACKGROUND task: the
 * root's turn settles with "I'm on it", and the real answer lands in a later
 * turn when the child reports back. A judge that reads the first turn grades
 * the acknowledgement. Follow up to `maxHops` such turns and return the last
 * one that settled; a turn that delegated nothing (or whose delegation already
 * completed inside it) is returned as is.
 */
export async function settleBackgroundWork(t: EveEvalContext, turn: EveEvalTurn, maxHops = 3): Promise<EveEvalTurn> {
  let current = turn;
  for (let hop = 0; hop < maxHops; hop++) {
    const delegated = current.events.some((event) => event.type === "subagent.called");
    const reported = current.events.some((event) => event.type === "subagent.completed");
    if (!delegated || reported) return current;
    const live = t.target.watchTurn(current.sessionId, { startIndex: current.session.state.streamIndex });
    current = await live.result();
  }
  return current;
}
