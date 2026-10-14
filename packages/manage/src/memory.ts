import { GET, POST, type RouteDefinition } from "eve/channels";

/**
 * The agent's long-term memory, for its owner's client: search it, see what it
 * learned lately, look one person or project up, correct it, and pin what must
 * never be forgotten.
 *
 * The client never holds a memory key. These routes call the memory server
 * with the agent's own workspace key from its environment (the same values its
 * memory extension reads), so a person sees exactly what the agent knows and
 * nothing beyond its workspace. Owner-only: memory is the whole company's.
 *
 * Answers are passed through as the server's markdown (`content`); the client
 * lays it out. Writes are additive: a correction is a new memory that the
 * server's contradiction handling lets win, never an edit of history.
 */
export interface MemoryOptions {
  /** Workspace (brain) to read. Defaults to ARCANA_COMPANY_WORKSPACE. */
  workspace?: string;
  /** Workspace-scoped key. Defaults to ARCANA_EVAL_API_KEY for an `-eval` workspace, else ARCANA_API_KEY. */
  apiKey?: string;
  /** The memory server's MCP endpoint. */
  url?: string;
  fetch?: typeof fetch;
}

export const MEMORY_MCP_URL = "https://mcp.arcana.kybernesis.ai/mcp";
const TIMEOUT_MS = 20_000;

export function memoryConfig(options: MemoryOptions = {}, env: Record<string, string | undefined> = process.env) {
  const workspace = options.workspace ?? env.ARCANA_COMPANY_WORKSPACE;
  const apiKey = options.apiKey ?? (workspace?.endsWith("-eval") ? env.ARCANA_EVAL_API_KEY : undefined) ?? env.ARCANA_API_KEY;
  return workspace && apiKey ? { workspace, apiKey, url: options.url ?? MEMORY_MCP_URL } : null;
}

/** One tool call, returning the tool's text payload (usually `{"content": "<markdown>"}`). */
export async function callMemory(
  config: { workspace: string; apiKey: string; url: string },
  tool: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-kyberagent-agent": config.workspace,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`memory answered ${response.status}`);
  const message = lastMessage(raw);
  if (!message) throw new Error("memory gave no answer");
  if (message.error) throw new Error(message.error.message ?? "memory refused the call");
  const text = (message.result?.content ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
  if (message.result?.isError) throw new Error(text.slice(0, 300) || "memory refused the call");
  return text;
}

/** The markdown inside a `{"content": "..."}` payload, or the payload itself. */
export function contentOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { content?: unknown }).content === "string") {
      return (parsed as { content: string }).content;
    }
  } catch {
    // plain text
  }
  return text;
}

interface RpcMessage {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

function lastMessage(raw: string): RpcMessage | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as RpcMessage;
    } catch {
      return null;
    }
  }
  let last: RpcMessage | null = null;
  for (const line of trimmed.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data.startsWith("{")) continue;
    try {
      last = JSON.parse(data) as RpcMessage;
    } catch {
      // keep the last good frame
    }
  }
  return last;
}

const clamp = (value: string | null, fallback: number, max: number) => Math.min(Math.max(Number(value) || fallback, 1), max);

export function memoryRoutes(input: {
  prefix: string;
  options: MemoryOptions;
  authorize: (req: Request) => Promise<Response | null>;
}): RouteDefinition[] {
  const prefix = `${input.prefix}/memory`;
  const run = async (tool: string, args: Record<string, unknown>): Promise<Response> => {
    const config = memoryConfig(input.options);
    if (!config) return Response.json({ ok: false, error: "This agent has no long-term memory set up." }, { status: 404 });
    try {
      const text = await callMemory(config, tool, args, input.options.fetch);
      return Response.json({ ok: true, content: contentOf(text) });
    } catch (error) {
      return Response.json({ ok: false, error: `Memory did not answer: ${(error as Error).message}` }, { status: 502 });
    }
  };

  return [
    // ?q= searches; without it, what it learned lately.
    GET(prefix, async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      const url = new URL(req.url);
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
      return q
        ? run("arcana_search", { query: q, limit: clamp(url.searchParams.get("limit"), 20, 50) })
        : run("arcana_timeline", { limit: clamp(url.searchParams.get("limit"), 30, 100) });
    }),

    // Everything it holds about one person, company, project or topic.
    GET(prefix + "/recall", async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      const entity = (new URL(req.url).searchParams.get("entity") ?? "").trim().slice(0, 200);
      if (!entity) return Response.json({ ok: false, error: "entity is required" }, { status: 400 });
      return run("arcana_recall", { entity });
    }),

    // Teach it something, or correct something it has wrong.
    POST(prefix + "/remember", async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      const body = (await req.json().catch(() => ({}))) as { text?: unknown; correction?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 4000) return Response.json({ ok: false, error: "text is required (up to 4,000 characters)" }, { status: 400 });
      const correction = body.correction === true;
      return run("arcana_remember", {
        text: correction ? `Correction from the agent's owner: ${text}` : text,
        tags: correction ? ["owner", "correction"] : ["owner"],
      });
    }),

    // Pin (never prune) or unpin a person, company or project.
    POST(prefix + "/pin", async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      const body = (await req.json().catch(() => ({}))) as { name?: unknown; pinned?: unknown };
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
      if (!name) return Response.json({ ok: false, error: "name is required" }, { status: 400 });
      return run(body.pinned === false ? "arcana_unpin_entity" : "arcana_pin_entity", { name });
    }),
  ];
}
