/**
 * Who a peer says prompted the call it just made.
 *
 * When one agent calls another through a granted edge, the call carries the
 * CALLING AGENT's authority — that is the whole point of a machine-to-machine
 * token. But the useful thing is almost always missing from it: a person asked
 * for this, and the answer usually needs to name them, be addressed to them, or
 * be declined because the work is not theirs.
 *
 * So the caller states who asked, the control plane records the statement in the
 * token, and this reads it back out.
 *
 * ## What it is not
 *
 * It is not authentication. The mint authenticates the calling agent and nothing
 * else, so this is that agent's word about a third party. A caller could put any
 * id here and the control plane would sign it, because signing it is all it can
 * honestly do.
 *
 * Use it to address someone, to log who work was done for, or to refuse. Never
 * to decide what an agent may reach: a tool that touches a person's data reads
 * the authenticated principal, and for an A2A call the authenticated principal
 * is an agent. Widening access on this value would let any agent holding one
 * edge act as any person it can name.
 */
export interface AssertedAsker {
  /** The caller's id for the person, usually a control-plane user id. */
  id: string;
  /** A human label — an email or name — when the caller had one. */
  label?: string;
}

/**
 * Read the asserted asker off a verified session.
 *
 * Returns undefined when the turn was not an A2A call, when the caller sent no
 * assertion, or when the session has no principal at all (a schedule, a
 * webhook), so a caller can treat all three the same way: nobody in particular
 * asked, answer as the agent.
 */
export function assertedAsker(session: unknown): AssertedAsker | undefined {
  const attributes = (
    session as {
      auth?: { current?: { attributes?: Record<string, unknown> } | null };
    }
  )?.auth?.current?.attributes;
  const id = attributes?.assertedAskerId;
  if (typeof id !== "string" || !id) return undefined;
  const label = attributes?.assertedAskerLabel;
  return typeof label === "string" && label ? { id, label } : { id };
}
