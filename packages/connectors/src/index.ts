import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { type McpServer, callMcpTool, listMcpTools } from "./mcp.js";

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
   * Resolve at `session.started` only, instead of on every turn.
   *
   * Per turn is the default, and the first deployment is why: connect Gmail
   * mid-conversation and the agent keeps saying it cannot see your mail until
   * you happen to start a new one, which reads as the connection being broken
   * rather than as a caching policy.
   *
   * The cost that argued for the old default is mostly handled by the memo
   * below. When nothing has changed the model sees an identical tool set, so
   * the prompt cache holds; it only breaks when the tools genuinely differ,
   * which is exactly when it should.
   */
  sessionOnly?: boolean;
  /** How long a resolved tool list is reused before asking again. */
  cacheMs?: number;
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

/**
 * Resolved tool lists, briefly.
 *
 * Per-turn resolution without this puts a network round trip in front of every
 * message. Keyed by principal, because the entire point is that two people get
 * different tools — a cache that forgot whose would hand one person's
 * connections to another.
 */
const memo = new Map<string, { at: number; tools: RemoteTool[] }>();

async function fetchTools(
  options: ConnectorToolsOptions,
  user?: string,
): Promise<RemoteTool[]> {
  const credential = credentialOf(options);
  if (!credential) return [];

  const key = user ?? "(shared)";
  const ttl = options.cacheMs ?? 60_000;
  const cached = memo.get(key);
  if (cached && Date.now() - cached.at < ttl) return cached.tools;
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
    const tools = body.tools ?? [];
    memo.set(key, { at: Date.now(), tools });
    return tools;
  } catch {
    // A control plane that cannot be reached means no connector tools this
    // session, not a broken agent. Everything authored still works.
    return [];
  }
}

/**
 * Remote MCP servers this principal has added.
 *
 * Separate from the broker's tools because the agent talks to these itself: the
 * control plane hands over a URL and a header, and the conversation happens
 * between two cloud services. Routing tool results through the control plane
 * would put customer data somewhere it has no reason to be.
 */
async function fetchMcpServers(
  options: ConnectorToolsOptions,
  user?: string,
): Promise<McpServer[]> {
  const credential = credentialOf(options);
  if (!credential) return [];
  try {
    const res = await fetch(`${base(options)}/api/connectors/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify({ ...(user ? { user } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { servers?: McpServer[] };
    return body.servers ?? [];
  } catch {
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

    const entries: [string, unknown][] = [];

    // Remote MCP servers, each namespaced by its own slug: two servers
    // exposing `search` is ordinary, and the model must be able to say which.
    for (const server of await fetchMcpServers(options, user)) {
      let remote: { name: string; description?: string }[] = [];
      try {
        remote = await listMcpTools(server);
      } catch {
        // One unreachable server must not cost the others their tools.
        continue;
      }
      for (const tool of remote) {
        entries.push([
          `${server.slug}_${tool.name}`.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
          defineTool({
            description: `${tool.description ?? tool.name} — from ${server.name}.`,
            inputSchema: z.object({}).passthrough(),
            execute: (input: Record<string, unknown>) =>
              callMcpTool(server, tool.name, input),
          }),
        ]);
      }
    }

    entries.push(
      ...tools.map((tool): [string, unknown] => [
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

    return entries.length ? Object.fromEntries(entries) : null;
  };

  return defineDynamic({
    events: options.sessionOnly
      ? { "session.started": resolve }
      : { "turn.started": resolve },
  });
}
