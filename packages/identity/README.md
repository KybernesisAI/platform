# @kybernesis/identity

Give an eve agent its `.agent` name. ARP Cloud holds the identity, the key, the
permissions and the audit trail; this package is the thin end: it verifies the
tokens ARP Cloud signs when it delivers a message, serves the document ARP Cloud
checks when you attach the runtime, and turns your paired peers into tools.

No daemon. No socket. No private key in your deployment.

## Install

```bash
eve add @kybernesis/identity-channel   # agent/channels/arp.ts
eve add @kybernesis/identity-peers     # agent/tools/arp-peers.ts
```

Then, in the ARP console (`cloud.arp.run/names/<name>` → Runtime → Attach), give
it `https://<your-agent-host>/eve/v1/arp`. The console verifies the document this
package serves and hands you four variables to set on the deployment:

```
ARP_ISSUER=https://gateway.arp.run
ARP_AGENT_DID=did:web:<name>.agent
ARP_AGENT_CREDENTIAL=<shown once>
AGENTID_CHALLENGE=<from the attach step>
```

Add `arpAuth()` to your eve channel's auth walk so deliveries are accepted:

```ts
// agent/channels/eve.ts
import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { arpAuth } from "@kybernesis/identity";

export default eveChannel({ auth: [arpAuth(), localDev()] });
```

(With `@kybernesis/dispatch`: `dispatchChannel({ trustedPeers, extraAuth: [arpAuth()] })`.)

## What each piece does

- `arpAuth()` — route auth. A delivery from ARP Cloud carries an ES256 token
  verified against `https://gateway.arp.run/.well-known/jwks.json`, naming this
  agent as audience and the paired peer as subject. The session principal is
  `principalType: "agent"`, `authenticator: "arp"`, with `peerDid`,
  `connectionId`, `purpose` and `obligations` as attributes.
- `identityChannel()` — serves `GET /eve/v1/arp/.well-known/agentid-verification`
  (`{ did, challenge }`) and `/eve/v1/arp/health`.
- `arpPeers()` — on every turn, lists active connections from ARP Cloud and
  exposes `ask_<peer>` tools. Pair or revoke in the console; nothing to redeploy.
- `ARP_INSTRUCTIONS` — append to your instructions so the model uses the tools well.

Degrades, never throws at boot: with no credential there are simply no peer
tools; with no token the auth entry skips to the next one.
