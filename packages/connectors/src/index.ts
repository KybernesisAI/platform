import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Connector tools, resolved for whoever is actually talking.
 *
 * A connection belongs to a person, not to a deployment. Gmail connected by one
 * colleague must not become a tool in another's turn, and an agent cannot know
 * at build time who will be talking to it — so these tools cannot be authored
 * files. They are resolved per session from the identity that authenticated the
 * turn, which is the same identity the control plane keys connections on.
 *
 * Nothing here holds a provider credential. The agent asks the control plane
 * what this principal can do, and calls back through it to do anything; the
 * broker's key stays in one process, and an agent that is compromised reaches
 * only what the person in front of it had already connected.
 *
 * ```ts title="agent/tools/connectors.ts"
 * import { connectorTools } from "@kybernesis/connectors";
 * export default connectorTools();
 * ```
 */

export interface ConnectorToolsOptions {
  /** Control-plane base URL. Defaults to KYBERNESIS_ISSUER. */
  issuer?: string;
  /** This agent's credential. Defaults to KYBERNESIS_AGENT_CREDENTIAL. */
  credential?: string;
  /**
   * Resolve at `turn.started` instead of `session.started`.
   *
   * Off by default: tool sets are part of the prompt, and rebuilding them every
   * turn re-ingests the conversation at uncached prices. Turn on where people
   * connect things mid-conversation and expect them to work immediately.
   */
  perTurn?: boolean;
}

interface RemoteTool {
  slug: string;
  name: string;
  description?: string;
  toolkit?: string;
  inputSchema?: Record<string, unknown>;
}

function base(options: ConnectorToolsOptions): string {
  return (
    options.issuer ??
    process.env.KYBERNESIS_ISSUER ??
    "https://agent.kybernesis.ai"
  ).replace(/\/$/, "");
}

function credentialOf(options: ConnectorToolsOptions): string | undefined {
  return options.credential ?? process.env.KYBERNESIS_AGENT_CREDENTIAL;
}

/**
 * The person whose turn this is, from the verified session principal.
 *
 * Undefined for an unattended run — a schedule, a webhook — and the control
 * plane answers those with the shared principal. That is why a connector meant
 * for a morning briefing has to be connected for the company rather than for a
 * person: at 8am there is no person.
 */
function principalOf(ctx: unknown): string | undefined {
  const session = (ctx as { session?: { auth?: { current?: { principalId?: string } | null } } })
    ?.session;
  return session?.auth?.current?.principalId;
}

/**
 * A JSON Schema from the broker, made safe to hand a model.
 *
 * Passed through as an object schema rather than reconstructed field by field:
 * these come from hundreds of services and any translation we invent will be
 * wrong for some of them in ways that only show up as a confused model.
 */
function argumentsSchema(_tool: RemoteTool): z.ZodType {
  return z.object({}).passthrough();
}

async function fetchTools(
  options: ConnectorToolsOptions,
  user?: string,
): Promise<RemoteTool[]> {
  const credential = credentialOf(options);
  if (!credential) return [];
  try {
    const res = await fetch(`${base(options)}/api/connectors/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ ...(user ? { user } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { tools?: RemoteTool[] };
    return body.tools ?? [];
  } catch {
    // A control plane that cannot be reached means no connector tools this
    // session, not a broken agent. Everything authored still works.
    return [];
  }
}

async function runTool(
  options: ConnectorToolsOptions,
  tool: string,
  args: Record<string, unknown>,
  user?: string,
): Promise<unknown> {
  const credential = credentialOf(options);
  if (!credential) {
    throw new Error("This agent has no control-plane credential, so it cannot use connectors.");
  }
  const res = await fetch(`${base(options)}/api/connectors/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ tool, arguments: args, ...(user ? { user } : {}) }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok) {
    // Surfaced to the model as text, deliberately: "you are not connected to
    // that" is something it can act on by telling the user, where a bare 403
    // invites it to retry the same call.
    throw new Error(body.error ?? `The connector call failed (${res.status}).`);
  }
  return body.result;
}

/** Tools for every service the current principal has connected. */
export function connectorTools(options: ConnectorToolsOptions = {}) {
  const resolve = async (_event: unknown, ctx: unknown) => {
    const user = principalOf(ctx);
    const tools = await fetchTools(options, user);
    if (!tools.length) return null;

    return Object.fromEntries(
      tools.map((tool) => [
        tool.slug.toLowerCase(),
        defineTool({
          description:
            tool.description ??
            `${tool.name}${tool.toolkit ? ` (${tool.toolkit})` : ""} — connected by the user.`,
          inputSchema: argumentsSchema(tool),
          execute: (input: Record<string, unknown>) =>
            runTool(options, tool.slug, input, user),
        }),
      ]),
    );
  };

  return defineDynamic({
    events: options.perTurn
      ? { "turn.started": resolve }
      : { "session.started": resolve },
  });
}
