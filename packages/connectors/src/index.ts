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
 * The broker's JSON Schema, turned into something a model can be held to.
 *
 * The first version passed everything through as an open object, which meant
 * the model got a tool name, a sentence of description, and no idea what
 * arguments existed. It guesses well enough to look like it works and badly
 * enough to fail on the third call — the worst possible middle. Composio
 * returns real schemas; dropping them was throwing away the only precise thing
 * in the payload.
 *
 * Translation is deliberately shallow. These schemas come from hundreds of
 * services and anything clever we invent will be wrong for some of them in ways
 * that surface as a confused model rather than an error, so unknown constructs
 * degrade to "unknown but named" instead of being reinterpreted. A field the
 * model can see and pass through is far better than a field it never knew about.
 */
function fieldSchema(spec: Record<string, unknown>): z.ZodTypeAny {
  const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
  const describe = (schema: z.ZodTypeAny): z.ZodTypeAny =>
    typeof spec.description === "string" ? schema.describe(spec.description) : schema;

  if (Array.isArray(spec.enum) && spec.enum.length) {
    const values = spec.enum.filter((v): v is string => typeof v === "string");
    if (values.length) return describe(z.enum(values as [string, ...string[]]));
  }

  switch (type) {
    case "string":
      return describe(z.string());
    case "number":
    case "integer":
      return describe(z.number());
    case "boolean":
      return describe(z.boolean());
    case "array": {
      const items = (spec.items ?? {}) as Record<string, unknown>;
      return describe(z.array(Object.keys(items).length ? fieldSchema(items) : z.unknown()));
    }
    case "object": {
      const properties = (spec.properties ?? {}) as Record<string, Record<string, unknown>>;
      if (!Object.keys(properties).length) return describe(z.record(z.string(), z.unknown()));
      return describe(objectSchema(spec));
    }
    default:
      return describe(z.unknown());
  }
}

function objectSchema(spec: Record<string, unknown>): z.ZodTypeAny {
  const properties = (spec.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(
    (Array.isArray(spec.required) ? spec.required : []).filter(
      (v): v is string => typeof v === "string",
    ),
  );

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, field] of Object.entries(properties)) {
    const built = fieldSchema(field ?? {});
    shape[name] = required.has(name) ? built : built.optional();
  }
  return z.object(shape);
}

/**
 * Exported so it can be tested directly. A tool schema is the contract a model
 * is held to — a mistranslated `required` or a dropped enum is a silent
 * accuracy loss, which is exactly the kind of bug that never announces itself.
 */
export function toolInputSchema(tool: { inputSchema?: Record<string, unknown> }): z.ZodType {
  const spec = tool.inputSchema;
  if (!spec || typeof spec !== "object") return z.object({}).passthrough();
  const properties = (spec.properties ?? {}) as Record<string, unknown>;
  // No properties means the broker told us nothing useful, and an empty object
  // schema would say "this tool takes no arguments" — a stronger and wronger
  // claim than staying open.
  if (!Object.keys(properties).length) return z.object({}).passthrough();
  return objectSchema(spec) as z.ZodType;
}

/**
 * Resolved tool lists, briefly.
 *
 * Per-turn resolution without this puts a network round trip in front of every
 * message. Keyed by principal, because the entire point is that two people get
 * different tools — a cache that forgot whose would hand one person's
 * connections to another.
 */
interface ConnectedAccount {
  id: string;
  /** What the person named it. Null when the service has only one account. */
  label: string | null;
}

const memo = new Map<string, { at: number; tools: RemoteTool[]; accounts: Accounts }>();

/** Connected accounts per service slug, as the control plane reports them. */
type Accounts = Record<string, ConnectedAccount[]>;

/**
 * Names for one service's tools, given the accounts behind it.
 *
 * Exported to be tested directly: getting this wrong does not throw, it sends
 * mail from the wrong mailbox. One account keeps the bare name — renaming
 * everyone's only Gmail to gmail_send_email_personal would be a worse prompt
 * and would rename tools under every agent already using them.
 */
export function toolNamesFor(
  toolSlug: string,
  accounts: { id: string; label: string | null }[],
): { name: string; account?: string }[] {
  const base = toolSlug.toLowerCase();
  if (accounts.length <= 1) return [{ name: base, account: accounts[0]?.id }];
  return accounts.map((a, i) => ({
    name: `${base}_${slug(a.label ?? `account_${i + 1}`)}`,
    account: a.id,
  }));
}

/** A tool name an agent can call: letters, digits, underscore. */
function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function fetchTools(
  options: ConnectorToolsOptions,
  user?: string,
): Promise<{ tools: RemoteTool[]; accounts: Accounts }> {
  const credential = credentialOf(options);
  const empty = { tools: [] as RemoteTool[], accounts: {} as Accounts };
  if (!credential) return empty;

  const key = user ?? "(shared)";
  const ttl = options.cacheMs ?? 60_000;
  const cached = memo.get(key);
  if (cached && Date.now() - cached.at < ttl) {
    return { tools: cached.tools, accounts: cached.accounts };
  }
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
    if (!res.ok) return empty;
    const body = (await res.json()) as { tools?: RemoteTool[]; accounts?: Accounts };
    const tools = body.tools ?? [];
    // Lower-cased keys: the toolkit on a tool and the slug on an account come
    // from different places in the broker's API and do not agree on case.
    const accounts: Accounts = Object.fromEntries(
      Object.entries(body.accounts ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    memo.set(key, { at: Date.now(), tools, accounts });
    return { tools, accounts };
  } catch {
    // A control plane that cannot be reached means no connector tools this
    // session, not a broken agent. Everything authored still works.
    return empty;
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
  account?: string,
): Promise<unknown> {
  const credential = credentialOf(options);
  if (!credential) {
    throw new Error("This agent has no control-plane credential, so it cannot use connectors.");
  }
  const res = await fetch(`${base(options)}/api/connectors/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({
      tool,
      arguments: args,
      ...(user ? { user } : {}),
      ...(account ? { account } : {}),
    }),
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
    const { tools, accounts } = await fetchTools(options, user);

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

    /**
     * One tool per account when a service is connected more than once.
     *
     * Tools belong to a toolkit, not to a connection, so two Gmail accounts
     * return one identical set — and an agent holding a single `gmail_send_email`
     * for two mailboxes sends from whichever the broker defaults to. Nobody can
     * predict which, and mail from the wrong account is not a retryable error.
     *
     * A service connected once is left exactly as it was. Appending "_personal"
     * to someone's only mailbox would be a worse prompt for the common case,
     * and it would rename tools under every agent already using them.
     */
    for (const tool of tools) {
      const forSlug = accounts[(tool.toolkit ?? "").toLowerCase()] ?? [];
      const labelOf = new Map(forSlug.map((a) => [a.id, a.label]));

      for (const named of toolNamesFor(tool.slug, forSlug)) {
        const label = named.account ? labelOf.get(named.account) : null;
        // Say which account only when there is more than one to choose between.
        // Otherwise every description grows a qualifier answering a question
        // nobody asked.
        const qualifier = forSlug.length > 1 && label ? ` Acts as the "${label}" account.` : "";
        entries.push([
          named.name,
          defineTool({
            description:
              (tool.description ??
                `${tool.name}${tool.toolkit ? ` (${tool.toolkit})` : ""} — connected by the user.`) +
              qualifier,
            inputSchema: toolInputSchema(tool),
            execute: (input: Record<string, unknown>) =>
              runTool(options, tool.slug, input, user, named.account),
          }),
        ]);
      }
    }

    return entries.length ? Object.fromEntries(entries) : null;
  };

  return defineDynamic({
    events: options.sessionOnly
      ? { "session.started": resolve }
      : { "turn.started": resolve },
  });
}
