import { eveChannel } from "eve/channels/eve";
import {
  localDev,
  placeholderAuth,
  vercelOidc,
  vercelSubject,
  type VercelSubjectEnvironment,
} from "eve/channels/auth";

/**
 * A peer deployment allowed to call this agent, named by its Vercel identity.
 *
 * Slugs, not IDs: `teamSlug` and `projectName` are the values embedded in the
 * OIDC `sub` claim (what `vercel ls` shows), not `team_…`/`prj_…` IDs. They
 * may not contain `*` or `:` — the underlying `vercelSubject` helper rejects
 * wildcarded inputs so a typo cannot silently widen trust.
 */
export interface PeerRef {
  /** Vercel team slug of the peer deployment (e.g. `"acme"`). */
  teamSlug: string;
  /** Vercel project name of the peer deployment (e.g. `"acme-router"`). */
  projectName: string;
  /**
   * Which environment of the peer to trust. Defaults to `"production"` so a
   * preview deployment can never assert identities against this agent unless
   * you opt in explicitly.
   */
  environment?: VercelSubjectEnvironment;
}

/** Compose the OIDC subject string for a peer. Exposed for doctor checks and tests. */
export function peerSubject(peer: PeerRef): string {
  return vercelSubject({
    teamSlug: peer.teamSlug,
    projectName: peer.projectName,
    ...(peer.environment !== undefined
      ? { environment: peer.environment }
      : {}),
  });
}

/** Options for {@link dispatchChannel}. */
export interface DispatchChannelOptions {
  /**
   * The deployments allowed to call this agent AND assert a forwarded
   * end-user principal. Must be non-empty — an agent with no peers should
   * simply not author a dispatch channel. There is deliberately no predicate
   * form: enumerating concrete peers is the whole point.
   */
  trustedPeers: readonly PeerRef[];
  /**
   * Extra `AuthFn`s appended to the walk (e.g. your web app's auth for a
   * browser frontend). The Vercel OIDC verifier for peers always runs first.
   */
  extraAuth?: Parameters<typeof eveChannel>[0] extends { auth?: infer A }
    ? A
    : never;
}

/**
 * The receiving side of an agent-to-agent edge: an authored eve channel that
 * accepts calls — and forwarded end-user principals — from exactly the peers
 * you enumerate.
 *
 * ```ts title="agent/channels/eve.ts"
 * import { dispatchChannel } from "@kybernesis/dispatch";
 *
 * export default dispatchChannel({
 *   trustedPeers: [{ teamSlug: "acme", projectName: "acme-router" }],
 * });
 * ```
 *
 * What you get over hand-rolling `eveChannel`:
 *
 * - Cross-project callers are enumerated in the OIDC `subjects` list AND the
 *   `trustedForwarders` predicate from one declaration — the two lists cannot
 *   drift apart.
 * - `trustedForwarders: () => true` is not expressible: trust is a list of
 *   concrete Vercel projects, never a function you can accidentally widen.
 * - This project's own deployments and `eve dev` keep working (current-project
 *   OIDC bypass + `localDev()`), and production browser traffic stays rejected
 *   via `placeholderAuth()` unless you pass real auth in `extraAuth`.
 */
export function dispatchChannel(options: DispatchChannelOptions) {
  const peers = options.trustedPeers;
  if (!Array.isArray(peers) || peers.length === 0) {
    throw new Error(
      "dispatchChannel: trustedPeers must name at least one peer deployment — an agent with no peers should not author a dispatch channel.",
    );
  }
  const subjects = peers.map(peerSubject);
  const subjectSet = new Set(subjects);
  const extra = (options.extraAuth ?? []) as never[];
  return eveChannel({
    auth: [
      // Verifies which deployment is calling: this project's own tokens are
      // always accepted; other projects only when enumerated as peers.
      vercelOidc({ subjects }),
      // Open on localhost for `eve dev` and the REPL; ignored in production.
      localDev(),
      ...extra,
      // Rejects production browser traffic with a structured 401 unless the
      // caller passed real auth above.
      placeholderAuth(),
    ],
    // Only enumerated peers may assert a forwarded end-user principal.
    trustedForwarders: (forwarder) =>
      typeof forwarder.subject === "string" &&
      subjectSet.has(forwarder.subject),
  });
}
