# @kybernesis/buzz

Put an eve agent in a [Buzz](https://buzz.xyz) workspace as a **member**, not as a shared
service account: every message is answered as the person who sent it.

```bash
npx kybernesis-buzz init          # create the agent's identity, print what to invite
npx kybernesis-buzz run           # run the bridge
```

## Why a member

A workspace signs every message with the sender's key, so the bridge knows exactly who spoke.
That is enough to run each turn as *that person* — their memory, their connections, their
grants — instead of collapsing a whole room onto one identity and giving everyone in it the
access of whoever set the agent up.

## How someone becomes known

Nobody is configured by hand. The first time a person talks to the agent, they are sent a
one-time sign-in link **privately**, they sign in to the control plane as themselves, and from
then on their turns run as them.

The privacy is the security argument, not politeness: holding that link is what proves control
of the account it names, so it is delivered to a direct conversation and never posted in a room.

Administrators can also link identities directly in the control plane, which is the path for
bulk provisioning.

## What the host holds

Only the agent's own key and the agent's own credential — neither of which can act as any
person. Every turn's authority is minted at the moment it is needed and expires shortly after,
so revoking a link, suspending a user or pulling a grant takes effect within one token lifetime
without redeploying anything.

## Presence, typing, and seen

A member that only ever speaks looks offline between sentences, so the bridge also publishes
what a person's client publishes: presence on a heartbeat, a typing indicator while a turn is
running, and 👀 on a message the moment it is picked up.

## More than one community

One agent, one identity, many communities. Membership is each workspace's to
grant, so being in two is two connections rather than two agents — invite the
same public key to each and list both relays:

```bash
BUZZ_RELAY="wss://one.communities.buzz.xyz,wss://two.communities.buzz.xyz"
```

Conversations never mix: a channel belongs to exactly one community, and
sessions are keyed by channel.

## Configuration

| Variable | Meaning |
| --- | --- |
| `BUZZ_RELAY` | The workspace relay (`wss://…`) — or several, comma-separated |
| `BUZZ_AGENT_URL` | Where the agent listens (default `http://127.0.0.1:8000`) |
| `BUZZ_KEYFILE` | The agent's key (default `~/.kybernesis/buzz-agent.json`) |
| `BUZZ_SESSIONS_FILE` | Channel-to-session continuity store (default beside the key file; an existing legacy `.buzz-sessions.json` is reused) |
| `KYBERNESIS_ISSUER` | The control plane |
| `KYBERNESIS_AGENT_CREDENTIAL` | This agent's credential |

`kybernesis-buzz service` prints a systemd unit for it. `kybernesis-buzz id <npub|hex>` shows a
public key in both forms, which is what the control plane's manual linking wants.

## Library

```ts
import { buzzBridge } from "@kybernesis/buzz";

const bridge = buzzBridge({
  relay: process.env.BUZZ_RELAY!,
  agentUrl: "http://127.0.0.1:8000",
  keyFile: "/etc/agent/buzz.json",
  issuer: process.env.KYBERNESIS_ISSUER!,
  credential: process.env.KYBERNESIS_AGENT_CREDENTIAL!,
});

console.log(`invite ${bridge.npub}`);
bridge.start();
```

Apache-2.0.
