# @kybernesis/dispatch

Agent-to-agent dispatch for [eve](https://eve.dev) agents: declared remote-peer
edges with principal forwarding on by default, and a receiver channel that makes
trusting the wrong caller hard to express.

Two separately deployed eve agents talk over a declared **edge**. The caller
mounts a `remotePeer` under `agent/subagents/`; the receiver authors its eve
channel with `dispatchChannel`. Underneath is eve's native `defineRemoteAgent`
transport — durable park-and-resume dispatch, retried callbacks, recursive
cancellation — with the governance defaults locked in.

## Caller side — one file per peer

```ts
// agent/subagents/gtm.ts  (file name = tool name the model sees)
import { remotePeer } from "@kybernesis/dispatch";

export default remotePeer({
  envVar: "GTM_AGENT_URL",
  description:
    "The company's GTM operator: posting cadence and history, open go-to-market plays, outreach targets, LinkedIn/X content drafting in the house voice.",
});
```

The `description` is a **routing hint**, not documentation: the calling agent's
model reads it to decide when to delegate. Write the concrete topics people
actually ask about. A vague description means the edge never fires.

Defaults you'd otherwise have to remember: outbound auth is Vercel OIDC, the
URL resolves from env at runtime (no rebuild to repoint), and
`forwardPrincipal: true` — the peer runs as the human who asked, so its memory
scoping, per-user connections, and telemetry attribution see the real person.

## Receiver side — enumerate your peers

```ts
// agent/channels/eve.ts
import { dispatchChannel } from "@kybernesis/dispatch";

export default dispatchChannel({
  trustedPeers: [{ teamSlug: "acme", projectName: "acme-router" }],
});
```

One declaration feeds both trust surfaces — the OIDC `subjects` allowlist
(which deployments may call at all) and the `trustedForwarders` predicate
(which of them may assert an end-user identity) — so the two can never drift
apart. There is deliberately no predicate form: `trustedForwarders: () => true`
(any authenticated caller asserts any identity, including your own preview
deployments) is not expressible through this API. Peers default to
`environment: "production"`; previews are never trusted implicitly.

Your own project's deployments and `eve dev` keep working (current-project
OIDC bypass + `localDev()`); production browser traffic stays rejected unless
you pass your app's real auth via `extraAuth`.

## Asserted asker on governed calls

A dynamic `governedPeers()` call carries the authenticated identity of the
calling agent, plus that agent's optional claim about the human who prompted
it. The human's authenticated authority does not travel with this call. On the
receiver, `assertedAsker(session)` from `@kybernesis/enterprise` reads the
caller's asserted asker.

The value is asserted rather than authenticated: the control plane signs the
token containing the claim, but does not verify the named human. Use it only for
non-escalating purposes such as greeting or addressing someone, attribution or
logging, tailoring a non-sensitive response, or refusing work. Never use it to
authorize access, widen permissions, impersonate a user, select user-scoped
credentials, or permit access to personal data. A tool that reaches personal
data must use the authenticated session principal, which on this agent-to-agent
call is the calling agent.

## Bidirectional edges

Answering is built into one edge — the caller parks until the peer's terminal
callback arrives, so request and response are one round trip on one wire. Add
the mirror-image files only when the *other* agent should also be able to
**initiate**: each direction is its own declared edge.

## Operational rules

- **Scheduled/proactive turns have no human to forward.** A turn triggered by
  a cron schedule carries no signed-in principal, so a dispatch made from it
  reaches the peer as the calling app's service identity even with
  `forwardPrincipal: true`. Design peer-side capabilities that scheduled turns
  rely on to be app-scoped (static keys), not user-scoped.

- **Upgrade both ends of an edge together.** A receiver on an eve version
  predating principal forwarding silently drops it and runs the session as the
  calling app's service identity — a security downgrade with no error.
- The env var (`GTM_AGENT_URL` above) holds the peer's stable production URL.
  Unset with no `fallbackUrl` fails the dispatch loudly — intended.
- Remote peers trace under their own deployment. Correlate hops in your
  observability via the `eve:forwarded-by` attribute and the child session id
  on the caller's `subagent.called` event.

## License

Apache-2.0
