import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Local execution: let a deployed agent work on the user's own machine.
 *
 * The agent runs in the cloud and the files are on a laptop, so nothing here
 * connects to anything. KYBER Studio holds an outbound poll to the control
 * plane, and these tools drop work into that queue and wait for the answer.
 * If Studio is closed, the tools say so plainly — the model should tell the
 * user their desktop is offline, not invent a reason the file is missing.
 *
 * Permission lives on the DESKTOP, not here. Every action names its effect
 * (run-command, read-file, write-file, list-directory) and Studio asks the user
 * per effect. An agent cannot bypass that by choosing a different tool, because
 * two tools that read a file out both declare `read-file`.
 *
 * Mount the tools individually under `agent/tools/`:
 *
 * ```ts title="agent/tools/local_shell.ts"
 * import { localShellTool } from "@kybernesis/local";
 * export default localShellTool();
 * ```
 */

export interface LocalToolsOptions {
  /** Control-plane base URL. Defaults to KYBERNESIS_ISSUER. */
  issuer?: string;
  /**
   * This agent's control-plane credential. Defaults to
   * KYBERNESIS_AGENT_CREDENTIAL — the same one used to mint A2A sessions.
   *
   * It replaces a shared secret that was hand-issued and said nothing about who
   * was calling: the relay had to take the agent's name from the request body,
   * so anything holding the secret could name any agent and reach that org's
   * desktops. The credential is signed by the org's keys and revoked by
   * disabling the agent, and the relay reads org and identity from the
   * signature.
   *
   * Still true, and still worth saying: reaching a desktop is not yet its own
   * revocable capability. "May talk to this agent" and "may run commands on my
   * laptop" remain one decision rather than two.
   */
  credential?: string;
}

interface CallResult {
  ok?: boolean;
  result?: unknown;
  error?: string;
  denied?: boolean;
  disconnected?: boolean;
  device?: string | null;
}

/**
 * How long the work may go SILENT before we call it stuck.
 *
 * This is an idle timeout, not a deadline. Because the desktop reports output
 * frames as they appear, a twenty-minute build keeps resetting this clock and
 * finishes, while a command that hangs is caught in a couple of minutes. A total
 * deadline gets both of those backwards: it kills healthy long work and waits
 * patiently on dead work.
 */
const IDLE_TIMEOUT_MS = 120_000;

/** Absolute ceiling, so a pathological job cannot hold a turn open forever. */
const HARD_CEILING_MS = 60 * 60_000;

interface StatusResult {
  status?: string;
  result?: unknown;
  error?: string;
  outputTail?: string | null;
  lastFrameAt?: string | null;
  deliveredAt?: string | null;
  createdAt?: string | null;
}

async function call(
  options: LocalToolsOptions,
  action: string,
  payload: Record<string, unknown>,
  user?: string,
): Promise<unknown> {
  const issuer = (
    options.issuer ??
    process.env.KYBERNESIS_ISSUER ??
    "https://agent.kybernesis.ai"
  ).replace(/\/$/, "");
  const credential = options.credential ?? process.env.KYBERNESIS_AGENT_CREDENTIAL;

  if (!credential) {
    throw new Error(
      "Local execution is not configured on this agent (KYBERNESIS_AGENT_CREDENTIAL is unset).",
    );
  }
  const auth = { "content-type": "application/json", authorization: `Bearer ${credential}` };

  const queued = await fetch(`${issuer}/api/local-exec/call`, {
    method: "POST",
    // No agent name in the body: the relay reads it from the credential's
    // signature. A name in the body is a claim, and a claim is exactly what
    // this route used to route on.
    headers: auth,
    body: JSON.stringify({ action, payload, ...(user ? { user } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (queued.status === 401) {
    throw new Error("The local-execution relay rejected this agent's credentials.");
  }
  if (!queued.ok) {
    throw new Error(`The local-execution relay refused this request (HTTP ${queued.status}).`);
  }
  const start = (await queued.json().catch(() => ({}))) as {
    ok?: boolean;
    jobId?: string;
    disconnected?: boolean;
    error?: string;
  };
  if (start.disconnected) throw new Error(start.error ?? "Your computer is not connected.");
  if (!start.jobId) throw new Error(start.error ?? "The relay did not accept this request.");

  const began = Date.now();
  let lastActivity = Date.now();
  let lastSeenFrame: string | null = null;

  for (;;) {
    await new Promise((r) => setTimeout(r, 1200));

    const res = await fetch(
      `${issuer}/api/local-exec/status?id=${encodeURIComponent(start.jobId)}`,
      { headers: auth, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) {
      // A failed poll is not a failed job; keep waiting within the idle window.
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
        throw new Error("Lost contact with the relay while the work was running.");
      }
      continue;
    }
    const s = (await res.json()) as StatusResult;

    // Any new frame — or simply being picked up — counts as being alive.
    if (s.lastFrameAt && s.lastFrameAt !== lastSeenFrame) {
      lastSeenFrame = s.lastFrameAt;
      lastActivity = Date.now();
    }
    if (s.status === "delivered" && !lastSeenFrame) lastActivity = Date.now();

    if (s.status === "done") return s.result;
    if (s.status === "denied") {
      throw new Error("The user declined this action on their computer.");
    }
    if (s.status === "error") throw new Error(s.error ?? "The action failed on your computer.");

    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      const tail = s.outputTail ? `\n\nLast output:\n${s.outputTail.slice(-800)}` : "";
      throw new Error(
        `No output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s — the command looks stuck, or the ` +
          `permission prompt is still waiting on their screen.${tail}`,
      );
    }
    if (Date.now() - began > HARD_CEILING_MS) {
      throw new Error("Gave up after an hour of work on this command.");
    }
  }
}

/**
 * The person whose turn is asking, from the verified session principal.
 *
 * kybernesisAuth puts the control-plane user id on the session, so this is the
 * same identity the agent's own door authenticated — not something the model
 * chose. It decides WHOSE machine the work reaches, which is why it must come
 * from the session rather than from a tool argument the model could set.
 *
 * Undefined for a turn with no signed-in principal (a schedule, an inbound
 * webhook). The relay then falls back to the org's most recent live desktop,
 * which is only ever right for a single operator.
 */
function askingUser(ctx: {
  session?: { auth?: { current?: { principalId?: string } | null } | null } | null;
}): string | undefined {
  return ctx.session?.auth?.current?.principalId;
}

export function localShellTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "Run a shell command on the USER'S OWN COMPUTER (not a sandbox), in their real files. Use when the user asks you to look at, build, or change something on their machine — a repo path like /Users/name/project, a local dev server, git in their working copy. Prefer local_read and local_list for inspection; use this when something must actually run.",
    inputSchema: z.object({
      command: z.string().describe("The command line to run, e.g. `git status`"),
      cwd: z.string().optional().describe("Absolute working directory on their machine"),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    }),
    execute: (input, ctx) => call(options, "run-command", input, askingUser(ctx)),
  });
}

export function localReadTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "Read a file from the user's own computer. Absolute paths only. Prefer this over a shell `cat`: same effect, clearer permission prompt, cleaner result.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path on their machine"),
      maxBytes: z.number().int().min(1).max(2_000_000).optional(),
      startLine: z.number().int().min(1).optional().describe("Read a window instead of the whole file"),
      endLine: z.number().int().min(1).optional(),
    }),
    execute: (input, ctx) => call(options, "read-file", input, askingUser(ctx)),
  });
}

export function localListTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "List a directory on the user's own computer. Absolute paths only. Use it to orient yourself in their project before reading or running anything.",
    inputSchema: z.object({
      path: z.string().describe("Absolute directory path on their machine"),
      depth: z.number().int().min(1).max(3).optional().describe("How deep to walk (default 1)"),
    }),
    execute: (input, ctx) => call(options, "list-directory", input, askingUser(ctx)),
  });
}

export function localWriteTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "Write a file on the user's own computer, creating parent directories as needed. This changes their real files — say what you are about to write before calling it.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path on their machine"),
      content: z.string(),
    }),
    execute: (input, ctx) => call(options, "write-file", input, askingUser(ctx)),
  });
}

/** Guidance to paste into the agent's own instructions. */
export const LOCAL_INSTRUCTIONS = `
## Working on the user's own computer

You have tools that act on the user's real machine through KYBER Studio:
local_shell, local_read, local_list, local_write. Absolute paths only.

Studio asks the user to approve each KIND of action the first time — running a
command, reading a file, writing a file, listing a directory. A refusal is an
answer: say they declined and stop, do not look for another route to the same
effect.

If a tool reports that the computer is not connected, tell the user plainly that
KYBER Studio needs to be open. Do not conclude their files or repo are missing,
and do not retry in a loop.

Before writing or running anything that changes their files, say what you are
about to do in one line. Reading and listing need no preamble.
`.trim();

/**
 * Replace exact text in a file on the user's machine.
 *
 * Declares the WRITE-FILE effect deliberately: editing and writing are the same
 * consequence for the user's code, so they share one consent. Giving edit its
 * own permission would let an agent reach an approved effect under a name the
 * user never approved — the exact hole that per-tool permissions create.
 */
export function localEditTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "Change part of a file on the user's own computer by replacing exact text. Prefer this over local_write for existing files: it edits in place instead of rewriting the whole file, and it refuses when the target text is missing or ambiguous rather than damaging the file. Read the file first so oldString matches exactly, including indentation.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path on their machine"),
      oldString: z.string().describe("Exact text to replace, unique within the file"),
      newString: z.string().describe("Replacement text"),
      replaceAll: z.boolean().optional().describe("Replace every occurrence instead of failing"),
    }),
    execute: (input, ctx) => call(options, "write-file", { ...input, op: "edit" }, askingUser(ctx)),
  });
}

/** Search file contents on the user's machine. Declares the read-file effect. */
export function localSearchTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "Search file contents under a directory on the user's own computer, by regular expression. Use it to find where something is defined or used before reading or editing. Skips .git, node_modules, and build output.",
    inputSchema: z.object({
      path: z.string().describe("Absolute directory to search under"),
      pattern: z.string().describe("Regular expression, case-insensitive"),
      glob: z.string().optional().describe("Only files ending with this, e.g. `.ts`"),
      maxResults: z.number().int().min(1).max(200).optional(),
    }),
    execute: (input, ctx) => call(options, "read-file", { ...input, op: "search" }, askingUser(ctx)),
  });
}

/**
 * An MCP server's JSON Schema, turned into something the model is held to.
 *
 * MCP servers publish real schemas on tools/list — Plaud's `get_file` declares
 * a required `file_id` with a description — and this resolver used to discard
 * them and hand the model an open object. Watching that play out: nine
 * consecutive calls guessing the argument name, steered only by error strings,
 * before it landed. The schema was in the payload the whole time.
 *
 * Deliberately shallow, and unknown constructs stay permissive: these come from
 * servers written by everyone, and a rule we invent that the server does not
 * have is worse than a field we pass through untyped.
 *
 * The same translation exists in @kybernesis/connectors for broker tools. Two
 * copies of fifty lines beats a dependency between two packages that otherwise
 * share nothing.
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
      const properties = (spec.properties ?? {}) as Record<string, unknown>;
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

/** An MCP tool's declared inputs, or an open object when it declares none. */
export function mcpInputSchema(spec: Record<string, unknown> | undefined): z.ZodType {
  if (!spec || typeof spec !== "object") return z.object({}).passthrough();
  const properties = (spec.properties ?? {}) as Record<string, unknown>;
  // No properties means the server told us nothing. An empty object schema
  // would claim the tool takes no arguments, which is a stronger and wronger
  // statement than staying open.
  if (!Object.keys(properties).length) return z.object({}).passthrough();
  return objectSchema(spec) as z.ZodType;
}

/**
 * Tools from MCP servers running on the user's own machine.
 *
 * The combination nothing else has: the agent reasons in the cloud, the server
 * runs beside the data, and neither needs the other to be reachable. A Postgres
 * inside a company network, a private repository, an internal API with no
 * ingress — the desktop dials out, so nothing is ever exposed.
 *
 * Resolved per turn from the same relay local execution already uses. A server
 * the user has not set up simply is not there; a machine that is closed reports
 * itself offline rather than failing a tool call halfway through.
 *
 * ```ts title="agent/tools/local_mcp.ts"
 * import { localMcpTools } from "@kybernesis/local";
 * export default localMcpTools();
 * ```
 */
/**
 * How long resolution may take, in total, before the turn goes on without it.
 *
 * This exists because the first version had no limit and stopped the agent
 * dead. Resolvers run BEFORE the model sees anything, so a slow answer here is
 * not a slow tool — it is an agent that never replies. A desktop that is
 * asleep, a server that is cold-starting under npx, a relay job nobody picks
 * up: all of them have to cost this much and no more.
 */
const RESOLVE_BUDGET_MS = 6_000;

/** Discovered tools, so a turn is not a relay round trip. */
const discovered = new Map<string, { at: number; tools: Record<string, unknown> }>();
const DISCOVERY_TTL_MS = 5 * 60_000;

/** Resolve, or give up quietly when the budget is gone. */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function localMcpTools(options: LocalToolsOptions = {}) {
  const resolve = async (_event: unknown, ctx: unknown) => {
    const user = askingUser(ctx as { session?: { auth?: { current?: { principalId?: string } | null } | null } | null });

    const cacheKey = user ?? "(shared)";
    const cached = discovered.get(cacheKey);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
      return Object.keys(cached.tools).length ? cached.tools : null;
    }

    const began = Date.now();
    const left = (): number => Math.max(0, RESOLVE_BUDGET_MS - (Date.now() - began));

    const servers = await within(
      (async () => {
        try {
          const listed = (await call(options, "local-mcp", { method: "servers/list" }, user)) as {
            servers?: { id: string; name: string }[];
          };
          return listed?.servers ?? [];
        } catch {
          // No desktop, or nothing set up. Neither is an error worth failing a
          // turn over — the agent simply has no local tools this time.
          return [];
        }
      })(),
      left(),
      [] as { id: string; name: string }[],
    );
    if (!servers.length) {
      // Remembered, so an absent desktop is not re-asked on every message.
      discovered.set(cacheKey, { at: Date.now(), tools: {} });
      return null;
    }

    const entries: [string, unknown][] = [];
    for (const server of servers) {
      if (left() <= 0) break;
      const tools = await within(
        (async () => {
          try {
            const listed = (await call(
              options,
              "local-mcp",
              { server: server.id, method: "tools/list" },
              user,
            )) as {
              tools?: {
                name: string;
                description?: string;
                inputSchema?: Record<string, unknown>;
              }[];
            };
            return listed?.tools ?? [];
          } catch {
            // One server being down must not cost the others their tools.
            return [];
          }
        })(),
        left(),
        [] as { name: string; description?: string; inputSchema?: Record<string, unknown> }[],
      );

      for (const tool of tools) {
        // Namespaced by server: two MCP servers exposing `query` are a real
        // possibility, and the model has to be able to say which one it means.
        entries.push([
          `${server.id}_${tool.name}`.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
          defineTool({
            description:
              `${tool.description ?? tool.name} — runs on the user's own computer via ${server.name}.`,
            inputSchema: mcpInputSchema(tool.inputSchema),
            execute: (input: Record<string, unknown>) =>
              call(
                options,
                "local-mcp",
                { server: server.id, method: "tools/call", params: { name: tool.name, arguments: input } },
                user,
              ),
          }),
        ]);
      }
    }

    const tools = Object.fromEntries(entries);
    discovered.set(cacheKey, { at: Date.now(), tools });
    return entries.length ? tools : null;
  };

  return defineDynamic({ events: { "turn.started": resolve } });
}
