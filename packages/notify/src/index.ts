/**
 * What the hook sends, and to whom.
 *
 * A person carrying a phone has no way of knowing an agent is waiting on
 * them. The agent does — it emitted the event — so it tells the control
 * plane "this person, this thread, a question" with its own credential, and
 * the control plane rings whatever phones that person registered. The agent
 * never holds a push token; the person is named from the verified session
 * principal, never guessed.
 */
export interface NotifyInput {
  issuer: string;
  credential: string;
  user: string;
  sessionId: string;
  kind: "question" | "reply";
  title?: string;
  body?: string;
}

/** The context shape the runtime hands a hook; only what this needs. */
export interface HookLike {
  session?: { id?: string; auth?: { current?: { principalId?: string } | null } | null } | null;
  agent?: { name?: string };
}

/** The person whose turn this is, from the verified session principal. Undefined for a schedule or an anonymous caller. */
export function askingUser(ctx: HookLike | undefined): string | undefined {
  return ctx?.session?.auth?.current?.principalId;
}

/** One line of a message, for a lock screen. */
export function preview(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** POST to the control plane. Never throws: a notification that could not be sent must not fail the turn. */
export async function notify(input: NotifyInput, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchImpl(`${input.issuer.replace(/\/$/, "")}/api/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.credential}` },
      body: JSON.stringify({ user: input.user, sessionId: input.sessionId, kind: input.kind, title: input.title, body: input.body }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
