/**
 * A small MCP client, enough to use someone else's server.
 *
 * Deliberately not the reference SDK: this runs inside an agent bundle where a
 * dependency is a build-time cost for every deployment, and the streamable HTTP
 * transport is a POST with JSON-RPC in the body. What it does need to get right
 * is the part servers actually disagree about — the session header and the two
 * response encodings — because getting either wrong looks like "the server is
 * broken" rather than "we spoke it badly".
 */

export interface McpServer {
  slug: string;
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
}

interface Session {
  /** Servers that issue one require it echoed on every later request. */
  id?: string;
  nextId: number;
}

const sessions = new Map<string, Session>();

/**
 * Read one JSON-RPC message from a response.
 *
 * Servers answer either application/json or text/event-stream, and the choice
 * is per server and sometimes per endpoint. A client that assumes JSON works
 * against half of them and fails mysteriously against the rest.
 */
async function readMessage(res: Response): Promise<Record<string, unknown> | null> {
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (!body.trim()) return null;

  if (type.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    return null;
  }

  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function rpc(
  server: McpServer,
  method: string,
  params: Record<string, unknown> | undefined,
  session: Session,
  notify = false,
): Promise<unknown> {
  const id = notify ? undefined : session.nextId++;
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Both, because we handle both and the server picks.
      accept: "application/json, text/event-stream",
      ...(session.id ? { "mcp-session-id": session.id } : {}),
      ...server.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      ...(params ? { params } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const issued = res.headers.get("mcp-session-id");
  if (issued) session.id = issued;

  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? `${server.name} refused the credentials for this connection.`
        : `${server.name} answered ${res.status}.`,
    );
  }
  if (notify) return undefined;

  const message = await readMessage(res);
  if (!message) throw new Error(`${server.name} returned nothing for ${method}.`);
  if (message.error) {
    const detail = (message.error as { message?: string }).message ?? "unknown error";
    throw new Error(`${server.name}: ${detail}`);
  }
  return message.result;
}

/** Handshake once per server, then reuse. */
async function connect(server: McpServer): Promise<Session> {
  const existing = sessions.get(server.url);
  if (existing) return existing;

  const session: Session = { nextId: 1 };
  await rpc(
    server,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "kybernesis-agent", version: "1.0.0" },
    },
    session,
  );
  // Required by the spec before normal traffic; servers that enforce it reject
  // everything after initialize without it.
  await rpc(server, "notifications/initialized", undefined, session, true).catch(() => undefined);

  sessions.set(server.url, session);
  return session;
}

export async function listMcpTools(server: McpServer): Promise<McpTool[]> {
  const session = await connect(server);
  const result = (await rpc(server, "tools/list", {}, session)) as { tools?: McpTool[] };
  return result?.tools ?? [];
}

export async function callMcpTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = await connect(server);
  try {
    return await rpc(server, "tools/call", { name, arguments: args }, session);
  } catch (error) {
    // A session can be dropped by the server (restart, idle expiry). One retry
    // from a fresh handshake turns that into a slow call instead of a failure
    // the user sees.
    sessions.delete(server.url);
    const fresh = await connect(server);
    return await rpc(server, "tools/call", { name, arguments: args }, fresh);
  }
}
