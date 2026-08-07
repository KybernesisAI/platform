import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

/** Options for {@link remotePeer}. */
export interface RemotePeerOptions {
  /**
   * Environment variable holding the peer deployment's URL (e.g.
   * `"GTM_AGENT_URL"`). Read at runtime on every dispatch, so repointing the
   * edge is an env change, not a rebuild.
   */
  envVar: string;
  /**
   * Fallback URL when the env var is unset. Optional — without it, a missing
   * env var fails the dispatch loudly, which is usually what you want in a
   * fresh environment.
   */
  fallbackUrl?: string;
  /**
   * The routing hint. The calling agent's model reads this to decide when to
   * delegate here — write it like the specialist's job description, with the
   * concrete topics people actually ask about, not a generic blurb. A vague
   * description means the edge never fires (or fires for the wrong asks).
   */
  description: string;
  /**
   * Forward the verified end-user principal across the hop (default `true`).
   * The receiver must name this deployment in its `dispatchChannel`
   * `trustedPeers` for the assertion to be accepted — otherwise the dispatch
   * fails with a 403 rather than silently downgrading.
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
 * ```ts title="agent/subagents/gtm.ts"
 * import { remotePeer } from "@kybernesis/dispatch";
 *
 * export default remotePeer({
 *   envVar: "GTM_AGENT_URL",
 *   description:
 *     "The company's GTM operator: posting cadence, open plays, outreach targets, content drafting.",
 * });
 * ```
 *
 * Outbound auth is always Vercel OIDC — the peer verifies which deployment is
 * calling before any principal assertion is considered.
 */
export function remotePeer(options: RemotePeerOptions) {
  const { envVar, fallbackUrl, description, outputSchema } = options;
  return defineRemoteAgent({
    url: () => {
      const url = process.env[envVar] ?? fallbackUrl;
      if (!url) {
        throw new Error(
          `remotePeer: ${envVar} is not set and no fallbackUrl was provided — set the peer deployment URL in the environment.`,
        );
      }
      return url;
    },
    description,
    auth: vercelOidc(),
    forwardPrincipal: options.forwardPrincipal ?? true,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  });
}
