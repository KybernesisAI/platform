/**
 * A minimal client for the Arcana MCP server over Streamable HTTP.
 *
 * The extension mounts Arcana as an eve MCP connection and lets eve do the
 * talking. A memory provider runs OUTSIDE the tool loop — before the model
 * sees the turn and after it answers — so it needs its own way to call the
 * same server. This is that, and nothing more: one JSON-RPC `tools/call` per
 * request, no session, no notifications. The server answers a bare call
 * without an `initialize` handshake, which is what keeps this small.
 */

export interface ArcanaClientOptions {
  apiKey: string;
  url?: string;
  fetch?: typeof fetch;
}

export interface ArcanaCallOptions {
  /** The workspace (brain) the call is scoped to; sent as `X-Kyberagent-Agent`. */
  workspace: string;
  signal?: AbortSignal;
}

export const ARCANA_MCP_URL = "https://mcp.arcana.kybernesis.ai/mcp";

export class ArcanaClient {
  readonly #apiKey: string;
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: ArcanaClientOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? ARCANA_MCP_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Call one Arcana tool and return the text it produced. Throws on a tool or transport error. */
  async call(tool: string, args: Record<string, unknown>, options: ArcanaCallOptions): Promise<string> {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-kyberagent-agent": options.workspace,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      signal: options.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Arcana HTTP ${response.status}: ${raw.slice(0, 200)}`);
    const message = lastJsonRpcMessage(raw);
    if (!message) throw new Error(`Arcana returned no JSON-RPC message for ${tool}`);
    if (message.error) throw new Error(`Arcana ${tool}: ${message.error.message ?? JSON.stringify(message.error)}`);
    const result = message.result ?? {};
    const text = (result.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    if (result.isError) throw new Error(`Arcana ${tool}: ${text.slice(0, 300)}`);
    return text;
  }
}

interface JsonRpcMessage {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

/** The body is either one JSON document or an SSE stream whose last `data:` line is the response. */
function lastJsonRpcMessage(raw: string): JsonRpcMessage | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcMessage;
  let last: JsonRpcMessage | null = null;
  for (const line of trimmed.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : null;
    if (data && data.startsWith("{")) {
      try {
        last = JSON.parse(data) as JsonRpcMessage;
      } catch {
        // a partial or non-JSON frame; keep the last good one
      }
    }
  }
  return last;
}

/**
 * Arcana's tools return their payload as a JSON string inside the text part:
 * `{"content": "# Search: ..."}` for the readers, `{"results": [...]}` for the
 * brain. Unwrap what is unwrappable and otherwise hand back the text as is.
 */
export function unwrapArcanaText(text: string): { content?: string; results?: unknown[]; raw: string } {
  try {
    const parsed = JSON.parse(text) as { content?: unknown; results?: unknown };
    return {
      content: typeof parsed.content === "string" ? parsed.content : undefined,
      results: Array.isArray(parsed.results) ? parsed.results : undefined,
      raw: text,
    };
  } catch {
    return { raw: text };
  }
}
