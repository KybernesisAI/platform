import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Every agent this one is ALLOWED to call, as tools — resolved from the control
 * plane, not from files.
 *
 * `remotePeer` needs a file per peer, which means a customer who grants an edge
 * in the admin then has to write code and redeploy before it does anything.
 * That is not a rough edge, it is a broken promise: the permission exists, the
 * UI says so, and nothing happens. This closes it — grant an edge and the tool
 * appears on the next turn; revoke it and it is gone.
 *
 * Mount once:
 *
 * ```ts title="agent/tools/peers.ts"
 * import { governedPeers } from "@kybernesis/dispatch";
 * export default governedPeers();
 * ```
 *
 * What this does NOT do, and it matters: `remotePeer` forwards the human's
 * principal, so the callee answers as the person who asked and can only surface
 * what they are entitled to see. These calls carry the CALLING AGENT's
 * identity instead. For peers that reach personal data, keep the declared
 * `remotePeer` — the file is worth it there. This is the right default for
 * everything else.
 */

export interface GovernedPeersOptions {
  /** Control-plane base URL. Defaults to KYBERNESIS_ISSUER. */
  issuer?: string;
  /** This agent's credential. Defaults to KYBERNESIS_AGENT_CREDENTIAL. */
  credential?: string;
  /**
   * How long a peer list is reused before asking again. Discovery runs before
   * every turn, so without this a room full of agents re-asks the control
   * plane on every message. Short enough that a revoke is felt in a minute.
   */
  cacheMs?: number;
  /** How long to wait for a peer's answer before giving up. */
  timeoutMs?: number;
  /**
   * Peers that already have a declared `remotePeer()` file, so they are not
   * offered twice.
   *
   * Some peers earn their file: `remotePeer` forwards the human's principal,
   * which is the only correct way to reach an agent holding personal data.
   * Discovery would list those peers too, and an agent shown two routes to the
   * same colleague will sometimes pick the one that answers as itself — the
   * quieter of the two failures, because it succeeds and returns less.
   *
   * Naming a peer here is not the thing this module exists to remove. It does
   * not make the peer reachable; the file already did that. It says "handled
   * elsewhere", and removing the line costs a duplicate, not a capability.
   */
  declared?: string[];
}

interface Peer {
  name: string;
  url: string;
  purpose: string;
}

const cache = new Map<string, { at: number; peers: Peer[] }>();

function config(options: GovernedPeersOptions) {
  const issuer = (options.issuer ?? process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai").replace(/\/$/, "");
  const credential = options.credential ?? process.env.KYBERNESIS_AGENT_CREDENTIAL;
  return { issuer, credential };
}

async function discover(options: GovernedPeersOptions): Promise<Peer[]> {
  const { issuer, credential } = config(options);
  if (!credential) return [];

  const key = `${issuer}:${credential.slice(-12)}`;
  const hit = cache.get(key);
  const ttl = options.cacheMs ?? 60_000;
  if (hit && Date.now() - hit.at < ttl) return hit.peers;

  try {
    const res = await fetch(`${issuer}/api/agent/peers`, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return hit?.peers ?? [];
    const body = (await res.json()) as { peers?: Peer[] };
    const peers = body.peers ?? [];
    cache.set(key, { at: Date.now(), peers });
    return peers;
  } catch {
    // A control plane that is briefly unreachable must not cost the agent its
    // other tools, and must not stall the turn. Last known list, or nothing.
    return hit?.peers ?? [];
  }
}

/** Mint a short-lived token for one callee, then hold the conversation. */
async function ask(
  options: GovernedPeersOptions,
  peer: Peer,
  message: string,
): Promise<string> {
  const { issuer, credential } = config(options);
  if (!credential) throw new Error("This agent has no control-plane credential, so it cannot call another agent.");

  const minted = await fetch(`${issuer}/api/agent/session`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ callee: peer.name }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!minted.ok) {
    const detail = (await minted.json().catch(() => ({}))) as { error?: string };
    // The edge was revoked between discovery and the call, or the peer was
    // disabled. Say which — a bare 403 here reads as a broken agent.
    if (detail.error === "edge_not_granted") {
      throw new Error(`Not allowed to contact ${peer.name} — the edge was revoked.`);
    }
    throw new Error(`Could not get permission to contact ${peer.name} (${minted.status}).`);
  }
  const { token } = (await minted.json()) as { token?: string };
  if (!token) throw new Error(`The control plane issued no token for ${peer.name}.`);

  const base = peer.url.replace(/\/$/, "");
  const timeout = options.timeoutMs ?? 180_000;
  const started = await fetch(`${base}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!started.ok) {
    throw new Error(`${peer.name} refused the message (HTTP ${started.status}).`);
  }
  const { sessionId } = (await started.json()) as { sessionId?: string };
  if (!sessionId) throw new Error(`${peer.name} did not open a session.`);

  /**
   * Read the turn off the peer's NDJSON stream, incrementally.
   *
   * The stream FOLLOWS the live session: it stays open after the turn so the
   * next one arrives on the same connection. Buffering it whole — `await
   * res.text()` — therefore waits for a connection that never closes, and the
   * call dies on its own timeout having already received the answer.
   *
   * That failure is host-shaped, which is what made it confusing: a callee on
   * serverless ends its response when the function returns, so a buffered read
   * resolves and everything looks correct. Against a callee on a long-lived
   * host, the identical code hangs every time.
   *
   * So: parse line by line as bytes arrive, and stop at the turn boundary.
   */
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeout);
  let reply = "";
  try {
    const res = await fetch(
      `${base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=0`,
      { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    if (!res.ok || !res.body) throw new Error(`${peer.name} would not stream its answer (HTTP ${res.status}).`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Keep the trailing fragment: a chunk boundary lands mid-line often
      // enough that dropping it loses whole events under load.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let event: { type?: string; data?: Record<string, unknown> };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        // Only a terminal message is the answer: eve emits narration as its own
        // completed message with finishReason "tool-calls", and treating those
        // as the reply returns the peer's intentions instead of its answer.
        if (event.type === "message.completed" && event.data?.finishReason === "stop") {
          reply = String(event.data.message ?? "");
        }
        if (event.type === "turn.failed" || event.type === "session.failed") {
          const detail = (event.data as { message?: string } | undefined)?.message;
          throw new Error(`${peer.name} failed to answer${detail ? `: ${detail}` : "."}`);
        }
        if (event.type === "session.waiting" || event.type === "turn.completed") {
          await reader.cancel().catch(() => {});
          if (reply) return reply;
          throw new Error(`${peer.name} finished its turn without a reply.`);
        }
      }
    }
    if (reply) return reply;
    throw new Error(`${peer.name} closed the stream without answering.`);
  } catch (error) {
    if (reply) return reply;
    if ((error as Error)?.name === "AbortError") {
      throw new Error(`${peer.name} did not answer within ${Math.round(timeout / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/** A tool name an agent can actually call: letters, digits, underscore. */
function toolName(peer: string): string {
  return `ask_${peer.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()}`;
}

export function governedPeers(options: GovernedPeersOptions = {}) {
  return defineDynamic({
    events: {
      "turn.started": async () => {
        const all = await discover(options);
        const skip = new Set((options.declared ?? []).map((n) => n.toLowerCase()));
        const peers = all.filter((p) => !skip.has(p.name.toLowerCase()));
        if (peers.length === 0) return null;

        const tools: Record<string, unknown> = {};
        for (const peer of peers) {
          tools[toolName(peer.name)] = defineTool({
            // The purpose recorded on the grant IS the routing hint. It was
            // already being written by whoever granted the edge; using it here
            // means the admin's description of why an edge exists is what the
            // model reads when deciding to use it.
            description:
              `Send a message to "${peer.name}", a separate agent, and get its reply. ` +
              (peer.purpose ? `Granted for: ${peer.purpose}. ` : "") +
              `Use it for work that belongs to that agent rather than answering from your own context.`,
            inputSchema: z.object({
              message: z
                .string()
                .describe("What to ask it. Write it as you would to a colleague — it has no view of this conversation."),
            }),
            execute: (input: { message: string }) => ask(options, peer, input.message),
          });
        }
        return tools;
      },
    },
  });
}
