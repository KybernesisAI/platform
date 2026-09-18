# @kybernesis/identity

Give an eve agent its `.agent` name.

ARP Cloud holds the identity, the key, the permissions and the audit trail. This
package is the thin end that lives inside the agent: it lets the owner connect
the agent from the console with one click, accepts the messages ARP Cloud
delivers, and turns paired agents into tools.

No daemon. No socket. No private key in your deployment. No environment
variables to copy.

## For owners

1. Register your name at [agent.arp.run](https://agent.arp.run).
2. On the name's page, **Connect your agent**: paste the agent's address and
   click Connect. That is all — the agent receives its identity from ARP Cloud
   and keeps it itself.
3. **Pair** with another agent from the same page; paired agents show up as
   `ask_<name>_agent` tools on the agent's next turn.

Agents built with Kybernesis tooling ship with this package already wired in.
For any other eve agent, the developer does the one-time setup below.

## For developers (one-time)

```bash
eve add @kybernesis/identity-channel   # agent/channels/arp.ts   → identityChannel()
eve add @kybernesis/identity-peers     # agent/tools/arp-peers.ts → arpPeers()
```

Then let deliveries in, on the eve channel:

```ts
// agent/channels/eve.ts
import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { arpAuth } from "@kybernesis/identity";

export default eveChannel({ auth: [arpAuth(), localDev()] });
// with @kybernesis/dispatch: dispatchChannel({ ..., extraAuth: [arpAuth(), ...] })
```

Optionally append `ARP_INSTRUCTIONS` to the agent's instructions. Deploy once.
From here on the owner connects, pairs and revokes in the console; nothing in
the codebase changes.

## How connect works

`POST /eve/v1/arp/connect` receives a short-lived ES256 token from ARP Cloud,
verifies it against `https://gateway.arp.run/.well-known/jwks.json`, checks it
was minted for this host, redeems it at the gateway for the agent's DID and
credential, and stores them in `.eve/arp-identity.json` (0600; path override
`ARP_IDENTITY_FILE`). `arpAuth()` and `arpPeers()` read that file per request,
so the connect takes effect without a restart.

An identity file written for another issuer is never overwritten; the owner
disconnects there first. Hosts without a writable disk (some serverless
platforms) keep the environment-variable path: `ARP_ISSUER`, `ARP_AGENT_DID`,
`ARP_AGENT_CREDENTIAL`, `AGENTID_CHALLENGE` (env always wins over the file).

## What each piece does

- `identityChannel()` — `/eve/v1/arp/connect`, `/eve/v1/arp/.well-known/agentid-verification` (`{ did, challenge }`) and `/eve/v1/arp/health`.
- `arpAuth()` — route auth for deliveries: an ES256 token signed by ARP Cloud, verified offline, naming this agent as audience and the paired peer as subject. Session principal: `principalType: "agent"`, `authenticator: "arp"`, with `peerDid`, `connectionId`, `purpose`, `obligations`.
- `arpPeers()` — on every turn, lists active connections and exposes `ask_<name>_agent` tools (the `_agent` suffix keeps them distinct from control-plane peers, which are `ask_<name>`).
- `ARP_INSTRUCTIONS` — text to append to your instructions.

Degrades, never throws at boot: with no identity there are no peer tools and the auth entry skips to the next one.
