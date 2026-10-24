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

## When it answers

In a room, when someone @mentions it, or replies to a question it asked. In a one-to-one direct
message, every message: a DM is addressed to the other member, mention or not, as with Buzz's
own agents. A group DM still needs the mention. The bridge learns which DMs it is in from the
relay's signed channel rosters, every thirty seconds, and reads a newly found DM back from the
last check so nothing sent in between is missed. Messages written by another agent (they carry
an owner attestation) are answered only when they mention it, so two agents in a DM never
answer each other forever.

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

## Who it says it is

An agent shows the name and picture its owner set in the app or KYBER Studio, and where the
owner has not chosen, what its `.agent` name says (display name, description, picture and
NIP-05 handle). The bridge reads the owner's choice from the control plane
(`GET /api/agent/profile`, with the agent's credential) and the name's public profile document
(`https://<name>.agentid.dev/.well-known/agent-profile.json`) when it starts and every fifteen
minutes, and writes the profile only in communities whose copy differs. The control plane holds
the picture as a small image, so it is uploaded to each community's own media store once per
change, and each community's profile points at its own copy: the Buzz app loads a community's
media only through that community, so a picture held by another one shows as no picture. A new picture or name reaches every community without a
command on the host. The `.agent` name comes from `ARP_AGENT_DID`, or from
`.eve/arp-identity.json` in the agent's directory.

`kybernesis-buzz profile --sync` does the same once, on demand: the owner's Sync profile button
runs it through `@kybernesis/manage` (`buzz.profile`). `kybernesis-buzz profile --from-agentid`
still takes the profile from the name alone.

## Cards

When a tool hands back a card (a chart, a table, a checklist, an artifact), the bridge posts it
after the reply as its own threaded message: the card's text for people to read, and the card
itself in an HTML comment (`<!-- kyb:card v1 {...} -->`) that Buzz hides. The reply stays an
ordinary message Buzz draws itself. The Kybernesis cards plugin for the Buzz desktop app
(`plugin/`) draws those messages as the card; without it people read the text.

An artifact posted into a channel is shared with the channel: the bridge asks the agent for a
share link as the person who asked (`POST /eve/v1/kyb/artifacts/:id/share`, `@kybernesis/manage`
0.28), and the card carries it. The plugin draws the page inside the card on the macOS desktop
app and opens it beside the conversation; everywhere else the link is in the text. The person
can withdraw the link from the agent. `BUZZ_CARDS=off` stops card messages.

## Configuration

| Variable | Meaning |
| --- | --- |
| `BUZZ_RELAY` | The workspace relay (`wss://…`) — or several, comma-separated |
| `BUZZ_AGENT_URL` | Where the agent listens (default `http://127.0.0.1:8000`) |
| `BUZZ_KEYFILE` | The agent's key (default `~/.kybernesis/buzz-agent.json`) |
| `BUZZ_SESSIONS_FILE` | Channel-to-session continuity store (default beside the key file; an existing legacy `.buzz-sessions.json` is reused) |
| `BUZZ_AGENT_SILENCE_TIMEOUT_MS` | Maximum silence before the agent acknowledges a request: unread drain, send and create acknowledgement (default `300000`, five minutes). This is where a genuine stall shows: no run is ever created. |
| `BUZZ_AGENT_WORK_TIMEOUT_MS` | Ceiling on silence once the response stream is open (default `3600000`, sixty minutes). The stream is quiet while the agent works, a long tool call or a delegated subagent produces nothing until it returns, so this is a ceiling on work, not a stall detector. |
| `BUZZ_CARDS` | `off` stops posting cards after replies (default on) |
| `BUZZ_PROFILE_SYNC_MS` | How often the profile is re-checked against the name and picture its owner set and its `.agent` name (default `900000`, fifteen minutes; `0` turns it off) |
| `AGENTID_MIRROR_SUFFIX` | Where names serve their public documents (default `.agentid.dev`); for staging only |
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
  agentSilenceTimeoutMs: 5 * 60_000,
});

console.log(`invite ${bridge.npub}`);
bridge.start();
```

Apache-2.0.
