import { defineChannel, GET } from "eve/channels";

export interface IdentityChannelOptions {
  /** This agent's identity, e.g. `did:web:samantha.agent`. Defaults to ARP_AGENT_DID. */
  agentDid?: string;
  /** The challenge ARP Cloud issued when attaching this runtime. Defaults to AGENTID_CHALLENGE. */
  challenge?: string;
}

export const IDENTITY_PREFIX = "/eve/v1/arp";

/**
 * Serves the identity verification document ARP Cloud fetches when this
 * runtime is attached to a name (`<url>/.well-known/agentid-verification`),
 * plus a health probe. Mount as `agent/channels/arp.ts`; attach the name with
 * URL `https://<host>/eve/v1/arp`.
 */
export function identityChannel(options: IdentityChannelOptions = {}) {
  return defineChannel({
    // Deliveries from ARP Cloud arrive on the eve channel (POST /eve/v1/session),
    // not here; this channel only owns the identity's HTTP documents.
    receive: async ({ message, auth }, { from }) => from("arp:inbox").send(message, { auth }),
    routes: [
      GET(IDENTITY_PREFIX + "/.well-known/agentid-verification", async () => {
        const did = options.agentDid ?? process.env.ARP_AGENT_DID ?? "";
        const challenge = options.challenge ?? process.env.AGENTID_CHALLENGE ?? "";
        if (!did || !challenge) {
          return Response.json({ error: "not_configured", hint: "set ARP_AGENT_DID and AGENTID_CHALLENGE" }, { status: 404 });
        }
        return Response.json({ did, challenge }, { headers: { "cache-control": "no-store" } });
      }),
      GET(IDENTITY_PREFIX + "/health", async () =>
        Response.json({ ok: true, did: options.agentDid ?? process.env.ARP_AGENT_DID ?? null }),
      ),
    ],
  });
}
