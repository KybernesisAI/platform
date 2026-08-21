---
description: Use when registering an agent with the Kybernesis control plane, granting/revoking user access, wiring kybernesisAuth, running the governance E2E check, or debugging 401/403s from a governed agent.
---

# The Kybernesis control plane (agent.kybernesis.ai)

The control plane governs WHO may talk to which agent. It is an OIDC-style
issuer (per-org ES256 keys at `/api/jwks`) minting **IdentitySessions**
`{ issuer, token, bundle, jwks }`; the policy bundle carries
`agentGrants[{agent, level}]`. Agents verify OFFLINE via
`kybernesisAuth()` from `@kybernesis/enterprise` — no callback to the plane
on each request.

## Wiring a governed agent

Env: `KYBERNESIS_ISSUER=https://agent.kybernesis.ai` and
`KYBERNESIS_AGENT=<agent-name>` (must equal the name registered in the
admin). The registry item writes the route-auth file; `kyb doctor` checks
JWKS reachability. Callers send `authorization: Bearer <token>` +
`x-kybernesis-bundle: <bundle>`. Expected failures: 401 = no/bad
credentials; 403 `agent_not_granted` = valid user, no grant for THIS agent.

## Admin flow (browser, agent.kybernesis.ai)

Register the agent under Agents (runtime: ▲ eve + deployment URL — the row
shows a health probe). Grant users under their profile (grants resolve at
MINT time). Users page also links/revokes chat identities (platform id ↔ user) — the
manual/bulk path; see "Chat identity" below for the self-service one.
Sign-in for humans is RFC 8628 device flow (user code, e.g. ABCD-EFGH).

## Chat identity (how a room full of people becomes people)

`POST /api/agent/identity` — the door a channel bridge knocks on. Agent
authenticates with its OWN credential (`KYBERNESIS_AGENT_CREDENTIAL`), passes
`{provider, externalId}`, gets back `{token, bundle}` minted FOR THAT PERSON.
Client side is `channelIdentity()` in `@kybernesis/enterprise`.

- **Unlinked → 404 `{error:"not_linked", link}`**, not an error to show: the
  bridge delivers that link to the sender **privately** on the platform they
  used. Delivery IS the proof of control — a link posted in a room lets anyone
  in that room claim to be that person. Single-use, 15 min, org-scoped.
- The person claims it at `/link/<code>`: they sign in as themselves, confirm,
  and `external_identity` is written. **They must already be a user in the org**
  (invited or SSO) or the link dead-ends at the sign-in wall — this is the
  most likely "it didn't work" report.
- Linked but ungranted → 403 `agent_not_granted`; the bridge tells them so.
  Refusals are NOT cached, so granting takes effect on their next message.
- Tokens are 5 min here (`CHANNEL_IDENTITY_TTL_SECONDS`), not the 1h default:
  a bridge re-mints per turn, so revocation lands in minutes and the host holds
  nothing durable for anybody.

Order is free: link-then-grant and grant-then-link both work.

## Timing semantics (the support-ticket section)

Token TTL defaults to 1h — that IS the revocation SLA for already-minted
sessions. Suspension blocks new mints immediately; revocation of a grant
takes effect at next mint. Tune `IDENTITY_TOKEN_TTL_SECONDS` to the client's
appetite and tell them the number.

## The governance E2E check (run before any client demo)

1. Call the governed agent with no credentials → expect 401.
2. Mint via device flow WITHOUT a grant → call → expect 403 agent_not_granted.
3. Grant the user in the admin → re-mint → call → expect 200/202.
4. Revoke the grant → old token still works until TTL; re-mint refused.
5. Suspend the user → mint refused immediately; restore → mint works.

For an agent on a chat surface, the same check has a channel form, verified
against production 2026-08-20: unlinked sender → gets a link privately (and
nothing in the room); claims it → next message answers as them (the bridge log
names their EMAIL, not their platform id); ungranted → "no access yet"; grant →
works on the next message.

This exact sequence was verified against production 2026-08-05. The demo
moment for clients is step 3→4 — access appearing and disappearing from the
admin screen.

## It also brokers connectors and the user's own machine

Governance was the first job; the plane now also holds the two things an agent
cannot hold itself.

**Connectors** (`/api/connectors`, `link`, `disconnect`, `tools`, `execute`,
`custom`, `mcp`, `mcp/test`). Each ORG holds its own broker (Composio) API key,
encrypted at rest with `SECRET_ENCRYPTION_KEY` (AES-256-GCM,
`v1:<iv>:<tag>:<ct>`), set
through the admin — never an env var, never our key used for a client. The
agent asks the plane which services the CURRENT principal has connected;
`@kybernesis/connectors` turns the answer into tools for that turn only. The
broker's entity is `<registered-agent-name>:<userId>` — the registered NAME,
not the agent's UUID.

**Local access** (`/api/local-exec/*`). A device enrolls, the user grants it
once, and that grant is STANDING — no expiry. Requests and responses are relayed
as frames; the plane never executes anything. See `@kybernesis/local`.

**A client must refresh on the earlier of the token and the bundle.** They have
independent lifetimes: a token with 57 minutes left and a bundle with 12 will
start returning 401 while every dashboard says the session is fine. This cost a
full day, presented to the user as "log out and log back in", and the fix is one
line — `Math.min(tokenExpiry, bundleExpiry)`. On a 401, force a refresh and
retry ONCE before showing a human anything.

## Boundaries to state plainly

Control-plane grants govern the HTTP/desktop doors — NOT the Slack door
(Slack access = workspace membership). Person-scoped approvals and
`governedSlackChannel()` are specced, not built. HITL approvals are
session-scoped; any thread member can click them.
