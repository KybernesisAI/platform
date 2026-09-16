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
  session?: {
    id?: string;
    auth?: { current?: { principalId?: string; principalType?: string } | null } | null;
  } | null;
  agent?: { name?: string };
}

/**
 * Principals that are the agent itself rather than a person.
 *
 * A schedule runs as the app, so its turns carry `eve:app` with
 * `principalType: "runtime"`. That is a perfectly good principal — it is simply
 * not somebody with a phone.
 */
function isMachinePrincipal(id: string, type: string | undefined): boolean {
  if (type === "runtime" || type === "app" || type === "agent") return true;
  // Namespaced framework principals, whatever the type says.
  return id.startsWith("eve:");
}

/**
 * The person whose turn this is, from the verified session principal. Undefined
 * for a schedule or an anonymous caller.
 *
 * This used to return whatever principal was on the session, and a routine's
 * turn carries `eve:app` — truthy, so it passed the caller's `!user` guard and
 * was POSTed to the control plane, which answered 500 every time. On the
 * reference host that was every scheduled turn: 50 notifications delivered for
 * real users, and three 500s, all of them routines. So a routine's completion
 * never reached anyone AND it errored on the way to not reaching them.
 *
 * Returning undefined is the honest answer: there is nobody to ring.
 */
export function askingUser(ctx: HookLike | undefined): string | undefined {
  const current = ctx?.session?.auth?.current;
  const id = current?.principalId;
  if (typeof id !== "string" || id === "") return undefined;
  return isMachinePrincipal(id, current?.principalType) ? undefined : id;
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
