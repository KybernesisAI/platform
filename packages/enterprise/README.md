# @kybernesis/enterprise

Enterprise governance for [eve](https://eve.dev) agents, backed by the
**Kybernesis control plane**: an org's admins invite employees, grant them
access to specific agents, and revoke that access — and every governed agent
enforces those decisions offline, per request, with no callback to the
control plane on the hot path.

## What it does

`kybernesisAuth()` is an eve route-auth entry (`AuthFn`) that admits only
callers holding a valid control-plane **IdentitySession** *with a grant for
this specific agent*:

- Verifies the identity token (`Authorization: Bearer …`) and policy bundle
  (`X-Kybernesis-Bundle: …`) — both compact JWS — **offline** against the
  control plane's JWKS (`<issuer>/api/jwks`).
- Cross-checks that the bundle belongs to the token's user and org.
- Requires an `agentGrants` entry matching this agent's registered name:
  no grant → `403 agent_not_granted` with a human-readable message.
- No/invalid credentials → falls through the auth walk → `401`. Fail-closed.

Revocation needs no infrastructure: grants are re-resolved at every mint and
tokens are short-TTL, so a revoked employee's next session simply lacks the
grant — and a **suspended** (off-boarded) employee cannot mint a session at
all. Sessions already in flight expire with the token.

## Usage

```ts
// agent/channels/eve.ts
import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { kybernesisAuth } from "@kybernesis/enterprise";

export default eveChannel({
  auth: [
    kybernesisAuth({
      issuer: process.env.KYBERNESIS_ISSUER!, // e.g. https://agent.kybernesis.ai
      agent: process.env.KYBERNESIS_AGENT!,   // this agent's name in the control plane
    }),
    // Loopback-only, production-inert; required for local eve eval runs (the
    // eval runner sends no credentials).
    localDev(),
  ],
});
```

The agent must be registered in the control plane (an `agent_ref` row with
`runtime='eve'`) under the same name, and callers obtain their
IdentitySession from the control plane (Studio, device flow, or the API).

## The caller contract

| Header | Contents |
| --- | --- |
| `Authorization: Bearer <token>` | Identity token: `iss`, `sub` (user), `org`, `email`, `exp` |
| `X-Kybernesis-Bundle: <bundle>` | Policy bundle: `user`, `org`, `agentGrants: [{agent, level}]`, `exp` |

On success the session principal carries `principalType: "user"`,
`principalId` = the control-plane user id, and attributes
`org`, `email`, `agentGrantLevel` (`use` | `manage`), and
`kybernesisGrants` — ready for `defineDynamic` capability gating and
`approval` policies.

## Verified behavior

The reference deployment exercises the full loop against a live control
plane: `401` with no credentials · `200` for a granted user · `403
agent_not_granted` after grant revocation · mint refusal for a suspended
user · restored access after re-grant.

## Roadmap

Planned modules in this package: `governedSlackChannel()` (grant-gated Slack
message hooks), `linkSlackIdentity()`, a policy-bundle `approval` adapter,
and an audit hook draining evlog wide events to the control plane.

## Security notes

- Verification is offline: only the JWKS endpoint is fetched (and cached by
  `jose`). An unreachable control plane cannot lock agents up — but also
  cannot extend a session past its TTL.
- Tokens carry identity and grants, never credentials.
- Pair route-level gating with capability-level gating (`defineDynamic` off
  the principal attributes) for defense in depth.
