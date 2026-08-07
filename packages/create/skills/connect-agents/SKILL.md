---
description: Use when connecting two deployed eve agents so one can delegate to the other — "connect agent A to agent B", agent-to-agent communication, remote peers, cross-deployment delegation. Wires @kybernesis/dispatch edges end to end.
---

# Connecting two eve agents (@kybernesis/dispatch)

An **edge** lets one deployed eve agent call another as if it were a local
subagent, with the human's identity carried across the hop. One edge covers a
full question-and-answer round trip (the caller parks until the peer's callback
returns). Wire the mirror-image edge only if the other agent should also be
able to *initiate*.

## Before wiring — gather the facts

1. **Both repos' eve versions must be compatible** (`node_modules/eve/package.json`
   in each). An old receiver silently drops principal forwarding and runs as
   service identity — no error. Upgrade both ends together first if they differ.
2. **Vercel identities** of both projects: team slug + project name as shown in
   `npx vercel ls <project>` (slugs, not `team_…`/`prj_…` IDs).
3. **Stable production URL** of the callee: `npx vercel inspect <latest-prod-url>`
   → Aliases — then **verify the alias is OPEN before wiring it**:
   `curl -s -o /dev/null -w "%{http_code}" <url>/eve/v1/health` must return
   **200**. The `<project>-<team>.vercel.app` aliases commonly sit behind
   Vercel SSO deployment protection (302 → vercel.com/sso-api) and CANNOT
   receive dispatches; the shorter production alias is usually the open one.
4. Both repos need `@kybernesis/dispatch` installed (`npm i @kybernesis/dispatch`).

## Caller side — one file

`agent/subagents/<peer-name>.ts` (file name = tool name the model routes to):

```ts
import { remotePeer } from "@kybernesis/dispatch";

export default remotePeer({
  envVar: "GTM_AGENT_URL",
  description: "…",   // see below — this is the whole routing story
});
```

**Write the description from the CALLEE's actual capabilities.** Read the peer
repo's `agent/instructions*`, subagent descriptions, and skills, then write the
concrete topics people ask about ("posting cadence, open GTM plays, outreach
targets, content drafting in the house voice") — not a generic blurb. If the
caller has local subagents with overlapping remits, differentiate explicitly or
routing will be ambiguous.

Set the env var on the caller's Vercel project:
`printf "<stable-prod-url>" | npx vercel env add GTM_AGENT_URL production`

## Receiver side — one file

`agent/channels/eve.ts` on the callee:

```ts
import { dispatchChannel } from "@kybernesis/dispatch";

export default dispatchChannel({
  trustedPeers: [{ teamSlug: "<caller-team>", projectName: "<caller-project>" }],
});
```

If the callee already has an authored `agent/channels/eve.ts` with app auth,
either migrate it to `dispatchChannel({ trustedPeers, extraAuth: […] })` or add
the peer by hand to BOTH the `vercelOidc({ subjects })` list and the
`trustedForwarders` predicate — they must never drift apart. Never write
`trustedForwarders: () => true`.

## Verify

1. `npx eve info` in both repos: 0 diagnostics; the caller's manifest gains a
   `remoteAgents` entry (it does NOT appear in the local subagent count).
2. `npm run typecheck` both.
3. Deploy BOTH (`npx eve deploy` / git push per repo convention). The edge is
   live only when both ends are.
4. Live test from the caller's real surface (e.g. Slack): ask something only
   the peer knows. Confirm delegation in the caller's reply, then check
   telemetry (PostHog): the peer-side turn should carry the human's
   distinct_id, plus the `eve:forwarded-by` attribute naming the caller.

## Failure signatures

- **403 on dispatch** → receiver has no authored eve channel, or the caller
  isn't in `trustedPeers`. Check team slug/project name spelling — a typo
  silently rejects everything.
- **`principal_required` on the peer's user-scoped connections** → forwarding
  isn't arriving: receiver predates forwarding, or the assertion was dropped.
- **Peer never gets called** → routing description too vague, or it collides
  with a local subagent's remit. Rewrite from the callee's real capabilities.
- **Works locally, 401 in production** → caller's OIDC not accepted: the
  receiver's `trustedPeers` names the wrong environment (default is
  production-only) or wrong project.
