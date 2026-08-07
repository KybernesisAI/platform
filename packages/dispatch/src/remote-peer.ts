import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

import { createA2ASessionSource, type GovernedOptions } from "./governed.js";

/** Options for {@link remotePeer}. */
export interface RemotePeerOptions {
  /**
   * Environment variable holding the peer deployment's URL (e.g.
   * `"GTM_AGENT_URL"`). Read at runtime on every dispatch, so repointing the
   * edge is an env change, not a rebuild. Required in ungoverned mode; in
   * governed mode it becomes an OVERRIDE on top of registry discovery.
   */
  envVar?: string;
  /**
   * Fallback URL when the env var is unset. Optional — without it, a missing
   * env var fails the dispatch loudly, which is usually what you want in a
   * fresh environment.
   */
  fallbackUrl?: string;
  /**
   * GOVERNED mode: the callee's registered name in the control plane. The edge
   * must be granted (caller→callee) in the admin; outbound auth becomes a
   * short-TTL A2A session token minted from `governed.issuer` using this
   * deployment's `KYBERNESIS_AGENT_CREDENTIAL`, and the callee's URL is
   * resolved from the registry (env var still wins as an override).
   */
  callee?: string;
  /** Control-plane settings for governed mode. Requires `callee`. */
  governed?: GovernedOptions;
  /**
   * The routing hint. The calling agent's model reads this to decide when to
   * delegate here — write it like the specialist's job description, with the
   * concrete topics people actually ask about, not a generic blurb. A vague
   * description means the edge never fires (or fires for the wrong asks).
   */
  description: string;
  /**
   * Forward the verified end-user principal across the hop (default `true`).
   * The receiver must trust this deployment (trustedPeers, or the verified
   * a2a caller principal in governed mode) for the assertion to be accepted —
   * otherwise the dispatch fails with a 403 rather than silently downgrading.
   *
   * Set `false` only when the peer should treat calls as coming from this
   * app itself (service identity) rather than from the human behind it.
   */
  forwardPrincipal?: boolean;
  /**
   * JSON Schema for task-mode structured output. When set, the peer returns
   * one validated result object instead of free text.
   */
  outputSchema?: Parameters<typeof defineRemoteAgent>[0]["outputSchema"];
}

/**
 * Declares a separately deployed eve agent as a callable peer of this agent.
 *
 * Mount under `agent/subagents/<name>.ts` — the file name becomes the tool
 * name the model sees. Lowers to the same `{ message }` tool shape as a local
 * subagent, with eve's durable dispatch underneath: the calling turn parks
 * without holding compute until the peer posts its terminal callback.
 *
 * Ungoverned (hand-wired):
 * ```ts title="agent/subagents/gtm.ts"
 * import { remotePeer } from "@kybernesis/dispatch";
 * export default remotePeer({
 *   envVar: "GTM_AGENT_URL",
 *   description: "The company's GTM operator: cadence, plays, targets, drafting.",
 * });
 * ```
 * Outbound auth is Vercel OIDC — the peer verifies which deployment is calling.
 *
 * Governed (control-plane edges):
 * ```ts title="agent/subagents/gtm.ts"
 * export default remotePeer({
 *   callee: "eve-gtm",
 *   governed: { issuer: "https://agent.kybernesis.ai" },
 *   description: "The company's GTM operator: cadence, plays, targets, drafting.",
 * });
 * ```
 * Outbound auth is a 5-minute A2A token minted per granted edge; the callee's
 * URL comes from the registry. Revoke the edge in the admin → the next mint
 * refuses → dispatches 403 within the token TTL.
 */
export function remotePeer(options: RemotePeerOptions) {
  const { envVar, fallbackUrl, description, outputSchema, callee, governed } = options;

  if (governed && !callee) {
    throw new Error("remotePeer: governed mode requires `callee` (the peer's registered control-plane name).");
  }

  const session = governed && callee ? createA2ASessionSource(governed.issuer, callee) : null;

  const url = async (): Promise<string> => {
    const override = envVar ? process.env[envVar] : undefined;
    if (override) return override;
    if (session) {
      const s = await session();
      if (s.callee.deploymentUrl) return s.callee.deploymentUrl;
    }
    if (fallbackUrl) return fallbackUrl;
    throw new Error(
      `remotePeer: no URL for this edge — ${
        session
          ? "the registry has no deploymentUrl for the callee and no envVar/fallbackUrl override is set."
          : `${envVar ?? "envVar"} is not set and no fallbackUrl was provided.`
      }`,
    );
  };

  const auth = session
    ? async () => {
        const s = await session();
        return { headers: { authorization: `Bearer ${s.token}` } as Readonly<Record<string, string>> };
      }
    : vercelOidc();

  return defineRemoteAgent({
    url,
    description,
    auth,
    forwardPrincipal: options.forwardPrincipal ?? true,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  });
}
