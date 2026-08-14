/**
 * Surface identity for multiplayer agents.
 *
 * A session is either a shared "channel" surface (public/multi-party: everything the
 * agent says is visible to everyone present, and multiple verified speakers drive one
 * durable session) or a private "dm" surface (a 1:1 personal-assistant session).
 *
 * The surface is stamped as a VERIFIED auth attribute by the channel factory's message
 * hooks — never inferred from prompts or model output. Read it in tools, approval
 * policies, dynamic resolvers, and connection auth/header resolvers to gate behavior.
 */
import type { SessionAuthContext } from "eve/context";

export type Surface = "channel" | "dm";

const SURFACE_ATTRIBUTE = "surface";
/** Pre-extraction deployments stamped this name; surfaceOf reads it as a fallback. */
const LEGACY_SURFACE_ATTRIBUTE = "kyber_surface";

/** Minimal session shape shared by `ctx.session` and approval-policy `session`. */
export interface SessionAuthLike {
  readonly auth: {
    readonly current: SessionAuthContext | null;
    readonly initiator?: SessionAuthContext | null;
  };
}

/** Stamp the surface onto a channel-derived auth context. */
export function withSurface(
  auth: SessionAuthContext | null,
  surface: Surface,
): SessionAuthContext | null {
  if (!auth) return null;
  return {
    ...auth,
    attributes: { ...auth.attributes, [SURFACE_ATTRIBUTE]: surface },
  };
}

/** Read the stamped surface off an auth context, if present. */
export function surfaceOf(
  auth: SessionAuthContext | null | undefined,
): Surface | null {
  const value =
    auth?.attributes[SURFACE_ATTRIBUTE] ??
    auth?.attributes[LEGACY_SURFACE_ATTRIBUTE];
  return value === "channel" || value === "dm" ? value : null;
}

/**
 * Surface of the active turn's caller. The `eve dev` TUI's synthetic `local-dev`
 * principal counts as a DM so the personal surface can be exercised locally;
 * deployed traffic only ever gets a surface via the channel factory's hooks.
 */
export function sessionSurface(session: SessionAuthLike): Surface | null {
  const caller = session.auth.current;
  if (caller?.principalType === "local-dev") return "dm";
  return surfaceOf(caller);
}

/**
 * Guard for DM-only capabilities. Throws (fails closed) unless the current caller
 * is a verified user in a direct message. The thrown message is model-visible, so
 * the agent can relay "DM me for that" naturally.
 */
export function requireDm(session: SessionAuthLike): SessionAuthContext {
  const caller = session.auth.current;
  if (caller?.principalType === "local-dev") return caller;
  if (surfaceOf(caller) !== "dm" || caller?.principalType !== "user") {
    throw new Error(
      "This is a personal capability and only works in a direct message with the agent. Ask the user to DM the agent instead.",
    );
  }
  return caller;
}

/**
 * Guard for capabilities whose RESULT should not land where everyone can read
 * it — someone's laptop, someone's inbox, someone's private repository.
 *
 * Distinct from `requireDm`, and the difference is the whole point. `requireDm`
 * fails closed on anything that is not a Slack DM, which also refuses KYBER
 * Studio and the eve TUI — surfaces with no audience at all, where the
 * capability is exactly what the person came for. This refuses only the surface
 * that is genuinely public: a shared channel, where the asker is one of several
 * people and the answer is visible to all of them.
 *
 * The concrete case: a Slack agent with local execution installed. "@agent read
 * ~/notes.md" in a shared channel is a verified request from someone with a
 * grant on their own machine — and posting that file into the channel shows it
 * to everyone in the room. Their device consent was never a decision about an
 * audience.
 *
 * The thrown message is model-visible, so the agent offers the obvious fix
 * itself instead of reporting a failure.
 */
export function refusePublic(session: SessionAuthLike, capability?: string): void {
  if (sessionSurface(session) !== "channel") return;
  const what = capability ? `${capability} ` : "";
  throw new Error(
    `This ${what}capability is private: the result would be visible to everyone in this ` +
      `channel. Do not retry it here — offer to continue in a direct message instead.`,
  );
}

/** Slack user id of the current caller, when the session came from Slack. */
export function slackUserIdOf(session: SessionAuthLike): string | null {
  const value = session.auth.current?.attributes.user_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
