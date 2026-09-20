import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveIdentity } from "./store.js";

export interface ArpPeersOptions {
  /** ARP Cloud gateway origin. Defaults to ARP_ISSUER, then https://gateway.arp.run. */
  issuer?: string;
  /** This agent's credential from "Attach runtime". Defaults to ARP_AGENT_CREDENTIAL. */
  credential?: string;
  /** Cache the connection list this long (ms). Default 60s. */
  cacheMs?: number;
  /** How long to wait for a peer's answer (ms). Default 120s. */
  timeoutMs?: number;
  /** fetch override (tests). */
  fetchImpl?: typeof fetch;
}

export interface ArpPeer {
  connectionId: string;
  peerDid: string;
  name: string;
  purpose: string | null;
}

const cache = new Map<string, { at: number; peers: ArpPeer[] }>();

function config(options: ArpPeersOptions) {
  // Per call, so a "Connect your agent" takes effect on the next turn.
  const id = resolveIdentity({ ...(options.issuer ? { issuer: options.issuer } : {}), ...(options.credential ? { credential: options.credential } : {}) });
  return {
    issuer: id.issuer,
    credential: id.credential,
    cacheMs: options.cacheMs ?? 60_000,
    timeoutMs: options.timeoutMs ?? 120_000,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
}

/** Active ARP connections for this agent, from the gateway's agent-API. Degrades to [] on any failure. */
export async function discoverPeers(options: ArpPeersOptions = {}): Promise<ArpPeer[]> {
  const c = config(options);
  if (!c.credential) return [];
  const key = `${c.issuer}|${c.credential.slice(0, 8)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < c.cacheMs) return hit.peers;
  try {
    const res = await c.fetchImpl(`${c.issuer}/agent-api/connections`, {
      headers: { authorization: `Bearer ${c.credential}` },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return hit?.peers ?? [];
    const body = (await res.json()) as {
      connections?: Array<{ connection_id: string; peer_did: string; peer_name: string; purpose: string | null }>;
    };
    const peers = (body.connections ?? []).map((k) => ({
      connectionId: k.connection_id,
      peerDid: k.peer_did,
      name: k.peer_name,
      purpose: k.purpose ?? null,
    }));
    cache.set(key, { at: Date.now(), peers });
    return peers;
  } catch {
    return hit?.peers ?? [];
  }
}

/**
 * The kinds of request an agent can make of a peer, and the ARP scope each one
 * is checked against. `message` is plain conversation (the baseline every
 * pairing grants); the rest are additive and only work when the peer's owner
 * granted that scope on the connection — otherwise ARP Cloud declines the
 * request before it reaches the peer, and both audit logs record the denial.
 */
export const INTENTS = {
  message: null,
  status: "work.status.read",
  projects: "work.projects.list",
  files: "files.projects.list",
  calendar: "calendar.events.modify",
} as const;
export type Intent = keyof typeof INTENTS;

/** Send one message to a paired peer through ARP Cloud and return its reply. */
export async function askPeer(options: ArpPeersOptions, peer: ArpPeer, message: string, intent: Intent = "message"): Promise<string> {
  const c = config(options);
  const action = INTENTS[intent] ?? null;
  const res = await c.fetchImpl(`${c.issuer}/agent-api/send`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.credential}` },
    body: JSON.stringify({ connection_id: peer.connectionId, text: message, wait_ms: c.timeoutMs, ...(action ? { action } : {}) }),
    signal: AbortSignal.timeout(c.timeoutMs + 10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reply?: string | null; timed_out?: boolean; error?: string; reason?: string };
  if (res.status === 403) return `${peer.name} declined: ${body.reason ?? "the message is outside what this connection allows."}`;
  if (!res.ok || body.ok === false) throw new Error(`${peer.name} could not be reached (${body.error ?? res.status}).`);
  if (body.timed_out || !body.reply) return `${peer.name} received the message but has not replied yet.`;
  return body.reply;
}

/**
 * `ask_<name>_agent` — the `_agent` suffix is the namespace. Without it the
 * tool collides with `@kybernesis/dispatch`'s control-plane peers (also
 * `ask_<name>`) whenever the same agent is reachable both ways, and eve
 * refuses to run the turn at all ("Dynamic tool ... collides with dynamic
 * resolver"). Hit live on 2026-09-18 with Sid ↔ Kyber.
 */
export function toolName(peerName: string): string {
  return `ask_${peerName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_agent`;
}

/**
 * Every agent this one is PAIRED with on ARP, as tools — resolved from ARP
 * Cloud at the start of each turn. Pair or revoke in the console and the tool
 * appears or disappears on the next turn; nothing to redeploy.
 */
export function arpPeers(options: ArpPeersOptions = {}) {
  return defineDynamic({
    events: {
      "turn.started": async () => {
        const peers = await discoverPeers(options);
        if (peers.length === 0) return null;
        const tools: Record<string, unknown> = {};
        for (const peer of peers) {
          tools[toolName(peer.name)] = defineTool({
            description:
              `Send a request to ${peer.name}.agent, a separate agent paired with you on the agent network, and get its reply. ` +
              (peer.purpose ? `Paired for: ${peer.purpose}. ` : "") +
              `Every request is checked against the permissions its owner granted for that kind of request and is logged for both sides.`,
            inputSchema: z.object({
              message: z.string().describe("What to ask or tell it. It has no view of this conversation."),
              intent: z
                .enum(Object.keys(INTENTS) as [Intent, ...Intent[]])
                .default("message")
                .describe(
                  "The kind of request: message (plain conversation), status (its current work status), projects (its project list), files (its project files), calendar (change its calendar). Its owner decides which kinds this connection allows; a kind that is not allowed is declined and logged on both sides.",
                ),
            }),
            execute: (input: { message: string; intent?: Intent }) => askPeer(options, peer, input.message, input.intent ?? "message"),
          });
        }
        return tools;
      },
    },
  });
}
