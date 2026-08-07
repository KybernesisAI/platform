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
   * end-user principal. There is deliberately no predicate form: enumerating
   * concrete peers is the whole point. Optional only when `governed` is set;
   * an agent with neither should simply not author a dispatch channel.
   */
  trustedPeers?: readonly PeerRef[];
  /**
   * GOVERNED mode: verify A2A session tokens minted by the Kybernesis control
   * plane for granted caller→callee edges (requires @kybernesis/enterprise
   * ≥0.2.0 installed). `agent` is THIS agent's registered name; a verified
   * a2a caller may call and assert forwarded principals — no peer enumeration
   * needed, and revoking the edge in the admin locks it out within the token
   * TTL (default 300 s). Composes with `trustedPeers` (union).
   */
  governed?: { issuer: string; agent: string };
  /**
   * Extra `AuthFn`s appended to the walk (e.g. your web app's auth for a
   * browser frontend). The peer verifiers always run first.
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
  const peers = options.trustedPeers ?? [];
  const governed = options.governed;
  if (peers.length === 0 && !governed) {
    throw new Error(
      "dispatchChannel: name at least one trustedPeers entry or set governed — an agent with no peers should not author a dispatch channel.",
    );
  }
  const subjects = peers.map(peerSubject);
  const subjectSet = new Set(subjects);
  const extra = (options.extraAuth ?? []) as never[];

  // Governed verifier, lazily imported so @kybernesis/enterprise stays an
  // optional peer: ungoverned users never load it, and a missing install
  // degrades to "governed callers get 401" at runtime with a clear log.
  type LooseAuthFn = (request: Request) => Promise<unknown>;
  let governedAuth: LooseAuthFn | null | undefined;
  const governedAuthFn: LooseAuthFn = async (request) => {
    if (governedAuth === undefined) {
      try {
        const mod = (await import("@kybernesis/enterprise")) as {
          kybernesisAuth: (o: { issuer: string; agent: string }) => LooseAuthFn;
        };
        governedAuth = mod.kybernesisAuth({ issuer: governed!.issuer, agent: governed!.agent });
      } catch {
        console.error(
          "[dispatch] governed mode requires @kybernesis/enterprise >=0.2.0 — install it or remove `governed`.",
        );
        governedAuth = null;
      }
    }
    return governedAuth ? governedAuth(request) : null;
  };

  return eveChannel({
    auth: [
      // Verifies which deployment is calling: this project's own tokens are
      // always accepted; other projects only when enumerated as peers.
      ...(peers.length > 0 ? [vercelOidc({ subjects })] : []),
      // Governed callers present a control-plane A2A session token instead.
      ...(governed ? [governedAuthFn as never] : []),
      // Open on localhost for `eve dev` and the REPL; ignored in production.
      localDev(),
      ...extra,
      // Rejects production browser traffic with a structured 401 unless the
      // caller passed real auth above.
      placeholderAuth(),
    ],
    // Enumerated peers OR a verified a2a agent principal (whose edge grant was
    // checked at mint, ≤TTL ago) may assert a forwarded end-user principal.
    trustedForwarders: (forwarder) =>
      (typeof forwarder.subject === "string" && subjectSet.has(forwarder.subject)) ||
      (Boolean(governed) &&
        forwarder.principalType === "agent" &&
        forwarder.authenticator === "kybernesis" &&
        (forwarder.attributes as Record<string, unknown> | undefined)?.kind === "a2a"),
  });
}
