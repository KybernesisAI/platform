# Connectors: a one-click library, and a door into the client's own network

Scope for the plugins library — what we build, in what order, and the decisions
that are expensive to change later.

## The shape

Three sources of tools, one surface. A card in the library says what it
connects and who it acts as; how the tools arrive is an implementation detail
the user never sees.

| provider | what it is | why it exists |
| --- | --- | --- |
| `composio` | brokered OAuth for hundreds of services | breadth. Registering an OAuth client per provider ourselves is ten a week and three hundred is a business |
| `eve-connect` | eve's native `connect()` via Vercel Connect | no fourth party in the credential path, for a client whose security review rejects one |
| `local-mcp` | an MCP server on the user's own machine, reached through the local-execution relay | the thing hosted desktop assistants cannot do |

**`provider` is on every card from day one.** Not because we need all three
immediately, but because the first enterprise client whose review rejects
Composio must cost us one connector, not the feature.

## Decisions already made

**Composio is the broker, and the key is the org's, held in the control plane.**
KBDE proved the pattern on 2026-06-30: entity `<agent>:<user>`, per-user MCP
token paths, shared fallback, 21/21 isolation tests. One org key, connected
accounts hung off an entity id — no per-user Composio accounts, no loophole
needed. Nobody outside the control plane ever sees the key, which is the same
rule as the agent credential.

**Entity id is `<agent>:<userId>`**, the userId being the control-plane identity
we already issue. Personal connections are per-person by construction, and
"whose Gmail" is answered by the identity that authenticated the turn.

**Unattended runs use a shared entity.** A routine firing at 8am has no
signed-in user, so a user-scoped connection cannot fire from one. KBDE's shared
fallback is the answer, and the card must say which mode it is — *runs as you*
versus *runs as the company* — before someone builds a morning briefing on a
connection that can never run unattended.

## Phase 1 — Connect a service

The spine. One person connects Gmail from Studio and the agent can read their
mail in the next turn.

**Control plane**
- `composio_credential`: the org's API key, encrypted, never returned by any
  route.
- `connector_catalog`: which toolkits an org has approved, so the library is a
  curated shelf rather than every service Composio carries.
- `GET /api/connectors` — approved cards plus this user's connection status.
- `POST /api/connectors/:slug/link` — creates the auth config if absent, calls
  `/api/v3.1/connected_accounts/link` with `user_id`, returns the redirect URL.
- `GET /api/connectors/:slug/status` — polled while the browser tab is open.
- `DELETE /api/connectors/:slug` — disconnect, `/api/v3/connected_accounts/:id`.

**Studio**
- The Plugins screen becomes the library: cards with mark, name, one line of
  description, connection state, and the *runs as* mode.
- Connect opens the system browser and polls until connected.
- Grant model matches local execution: connect once, stays connected until
  revoked.

**Cut line for phase 1:** ten services, connect and disconnect, status visible.
No tool configuration, no per-tool toggles, no scopes UI.

## Phase 2 — Tools reach the agent

The part that needs a spike before it is estimated.

Composio exposes tools over MCP per connected account. eve consumes MCP through
`defineMcpClientConnection`, which is an authored file — static, one per agent.
Per-user tools cannot be static.

**Approach: a dynamic resolver.** eve resolves tools at `session.started` and
`turn.started` with `ctx.session.auth` in hand, which is exactly the identity we
key entities on. `@kybernesis/connectors` ships a resolver that asks the control
plane which toolkits this principal has connected and returns MCP client
connections for them.

Open questions for the spike:
- Cost of resolving per turn; whether the connected-account list can be cached
  per session and invalidated on connect.
- Tool-name collisions between a Composio toolkit and an authored tool.
- What a revoked connection does to a turn already in flight.

**Fallback if the resolver is not viable:** write connection files at install
time through the manage channel, app-scoped only, and accept that personal
connections wait for the resolver.

## Phase 3 — Render the authorization challenge

Cheap, provider-agnostic, and already half-built in the framework.

eve emits `authorization.required` with a challenge URL, parks the turn, and
resumes after the callback. Studio drops the event today — which is the literal
row in eve's own troubleshooting table: *"`authorization.required` appears but
no UI."* Rendering it as a card (the pattern the question cards already use)
makes every eve-native connection one-click and gives Composio connections a
mid-turn path when a token expires.

A day's work. Do it alongside phase 1 rather than after.

## Phase 4 — Local MCP through the relay

The differentiator, and the reason to keep `provider` on the card.

Claude Desktop runs MCP servers on the user's machine because its model sits
next to them. Ours is remote — but since tonight it has a channel into the
laptop. A `local-mcp` connector runs a server on the user's machine and lets the
deployed agent call it: a private repo, a local Postgres, an internal tool
behind a VPN with no ingress at all.

**What has to be built**
- A relay action `mcp-rpc`: JSON-RPC frames over the request/response channel
  the local-exec relay already carries. Long-lived rather than one-shot, so the
  server keeps its session between calls.
- Server lifecycle in Studio: install, spawn, health, stop. Permission is per
  server, granted once, same standing model as everything else.
- An eve transport shim so `defineMcpClientConnection` can speak to a relay
  endpoint instead of a URL.

**Spike first:** whether MCP's session semantics survive a store-and-forward
relay with a polling desktop, and what the latency actually is per tool call.
If it is bad, the fallback is a local HTTP endpoint reached through a tunnel the
desktop opens — worse privacy story, simpler transport.

## The first ten

Weighted toward what the forward-deployment practice actually sells into, not
what a directory would put on a landing page.

1. **Gmail** — the single most asked-for
2. **Google Calendar** — scheduling is half of chief-of-staff work
3. **Google Drive** — documents the agent is asked to read
4. **Slack** — where the agent already lives for most clients
5. **Notion** — boards and docs; we run on it ourselves
6. **Linear** — engineering work
7. **GitHub** — repositories, issues, reviews
8. **Attio** — CRM; our own stack, and a strong demo
9. **Outlook / Microsoft 365** — the half of the market Google does not cover
10. **HubSpot** — the CRM most clients actually have

Fathom, Mercury, and PandaDoc are the obvious eleven through thirteen.

## Risks worth stating before we start

**Token residency.** Composio holds refresh tokens for a client's Google
Workspace and Slack — a fourth party alongside the model provider, Vercel, and
the host. Most clients will not blink; a regulated one will. `eve-connect` is
the answer for them, which is why it stays a first-class provider.

**"One click" is false when an admin must approve.** Slack, Notion, and Google
Workspace all have installs a normal employee cannot complete. The card must say
*needs an admin* before someone starts, not after they fail.

**Per-action pricing.** Composio bills per action. An agent in a loop is a very
different cost profile from a person clicking, and that belongs in the pricing
model before the first invoice.

**Revocation.** Disconnecting must kill the tools in the next turn, not the next
restart. The dynamic resolver makes this natural; a static connection file does
not.
