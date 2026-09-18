import { defineChannel, GET, POST } from "eve/channels";
import { handleConnect, requestHostOf, type ConnectOptions } from "./connect.js";
import { resolveIdentity, storeKind } from "./store.js";

export interface IdentityChannelOptions extends ConnectOptions {
  /** This agent's identity, e.g. `did:web:samantha.agent`. Defaults to ARP_AGENT_DID, then the identity file. */
  agentDid?: string;
  /** The challenge ARP Cloud issued when attaching this runtime. Defaults to AGENTID_CHALLENGE, then the identity file. */
  challenge?: string;
}

export const IDENTITY_PREFIX = "/eve/v1/arp";

/**
 * This agent's .agent identity surface:
 *
 *   POST /eve/v1/arp/connect                              — "Connect your agent" (ARP Cloud calls it)
 *   GET  /eve/v1/arp/.well-known/agentid-verification     — { did, challenge } ARP Cloud checks
 *   GET  /eve/v1/arp/health                                — { ok, did, store }
 *
 * Mount as `agent/channels/arp.ts`. Deliveries from paired agents arrive on
 * the eve channel (add `arpAuth()` there), not here.
 */
export function identityChannel(options: IdentityChannelOptions = {}) {
  return defineChannel({
    receive: async ({ message, auth }, { from }) => from("arp:inbox").send(message, { auth }),
    routes: [
      POST(IDENTITY_PREFIX + "/connect", async (req) => {
        let body: { token?: string; issuer?: string } = {};
        try { body = (await req.json()) as typeof body; } catch { /* bad json → 400 below */ }
        const { status, body: out } = await handleConnect(body, requestHostOf(req), options);
        return Response.json(out, { status, headers: { "cache-control": "no-store" } });
      }),
      GET(IDENTITY_PREFIX + "/.well-known/agentid-verification", async () => {
        const id = resolveIdentity(options);
        if (!id.did || !id.challenge) {
          return Response.json({ error: "not_configured", hint: "connect this agent to its name in the ARP console" }, { status: 404 });
        }
        return Response.json({ did: id.did, challenge: id.challenge }, { headers: { "cache-control": "no-store" } });
      }),
      GET(IDENTITY_PREFIX + "/health", async () => {
        const id = resolveIdentity(options);
        return Response.json({ ok: true, did: id.did || null, source: id.source, store: storeKind() });
      }),
    ],
  });
}
