# Gaps — what is built, what is untested, what is missing

State of the connector/MCP/Studio work as of 2026-08-13. Ordered by what would
hurt a paying client first, not by how interesting it is to fix.

Three categories, and the middle one is the dangerous one:

- **Missing** — known absent, nobody is surprised.
- **Built but unverified** — code exists, typechecks, has never completed a real
  run. This is where tonight's failures came from, every time.
- **Verified** — watched working end to end.

---

## Verified

- Gmail connected through Composio; Sid answered a real question from it.
- Plaud local MCP: connected, 7 tools, real answer through the relay.
- Local execution: read/list/search/run on the user's own machine.
- Routines: created from chat, applied, restarted, fired.
- Control-plane identity: device flow, grants, agent credential, standing grant.
- Sid's eval suite: 10 passed / 27 gates (before the connector work landed).

## Built but unverified — fix by testing, not by writing more

1. **Remote MCP (`mcp-direct`) end to end.** Routes, storage, and an MCP client
   that speaks both JSON and SSE all exist. No remote server has ever answered.
   Arcana was the obvious test and is out (we ship it in the core package), so
   this needs another one.
2. **`@kybernesis/connectors` tool execution against anything but Gmail.**
3. **Unattended connector runs.** A schedule has no signed-in user and gets the
   shared principal. Never exercised — the first symptom would be a morning
   briefing that silently does nothing.
4. **Studio's dead-man's switch and dispatch deadline.** Written after the
   wedges, never seen firing.
5. **Sid's evals since the connector and MCP tools landed.** Last green run
   predates six package changes.

## Missing — client-facing

1. **Remote MCP has no Connect.** A local server can sign in; a remote one that
   answers 401 has no affordance at all. Same gap that made Plaud look broken.
2. **No env fields when adding a local server.** Servers wanting `API_KEY=…`
   can only be configured by inlining it in the command, where it is visible in
   the row and stored in plain text.
3. **Tool volume is unmanaged.** Gmail alone is 23 tools, Plaud 7. Five services
   is a hundred-plus definitions in every prompt: real tokens on every turn and
   measurably worse selection. Curated top-N plus an escape hatch is the
   proposal; it needs an eval across flat / two-level / hybrid before we commit.
4. **Connector tools carry no argument schema.** Every one is
   `z.object({}).passthrough()`, so the model gets a name and a description and
   guesses the arguments. Composio returns real JSON Schema — we drop it.
5. **Nothing shows which machine a local server is on.** They are per-device by
   design; a second Mac silently has a different set.
6. **No admin screen for the connector catalog.** The ten are seeded; an org
   cannot add an eleventh or hide one without SQL.

## Missing — operational

7. **No CI.** Typecheck now runs inside `npm run build` — after a ReferenceError
   shipped into a running app — but nothing enforces it on push, and there are
   no tests anywhere in Studio.
8. **No tests for the transport.** The send path broke five distinct ways in one
   evening (cursor drift, unconsumed boundary, missing timeouts, a wedged queue,
   an unbounded resolver). Every fix was verified by hand.
9. **Studio is not packaged.** It runs from source via `npm run dev`. No signed
   build, no notarization, no auto-update. Nobody outside this machine can run
   it.
10. **Sid has no monitoring.** A stranded session, a dead turn, or a failed
    restart is discovered by a person noticing.
11. **Publishing is manual.** Every package needs a human at an npm browser
    prompt, which has repeatedly been the slowest step in a fix.

## Missing — security and governance

12. **Secrets are plaintext in Postgres.** `connector_secret`,
    `connector_provider.api_key`, `sso_connection.client_secret`. Encryption at
    rest is not in place; the existing convention is plaintext and I followed it
    rather than fixing it.
13. **Two consent systems that do not know about each other.** The control plane
    holds a standing per-device grant; Studio holds per-effect permissions in a
    local file. Revoking in one does not revoke the other.
14. **`local-mcp` is a single effect for every server.** Approving Plaud
    approves any MCP server added later, which is exactly the property we
    designed per-effect consent to avoid.
15. **Reaching a desktop is still not its own capability.** "May talk to this
    agent" and "may run commands on my laptop" remain one decision.
16. **Local execution runs in Studio's main process**, not a supervised daemon.
    A bug there takes the window with it.
17. **No audit trail for connector use.** Who ran which tool against whose
    account is not recorded anywhere a client could review.

## Known-and-accepted

- A restart strands an in-flight turn; eve does not resume a killed step.
  Mitigated (the restart waits for idle, Studio offers Reset) rather than solved.
- Composio holds refresh tokens for the client's Google and Slack — a fourth
  party. `eve-connect` is the answer for a client who refuses; it is unbuilt.
- Composio bills per action, and an agent in a loop is not a person clicking.

---

## What I would do next, in order

1. Sid's evals, plus a connector eval that proves Gmail and Plaud from a cold
   session. Everything in "built but unverified" stays a guess until then.
2. Argument schemas on connector tools — the cheapest accuracy win available.
3. Remote MCP Connect, and env fields on local servers. The two gaps that make a
   working feature look broken.
4. The tool-volume eval, then curation.
5. CI: typecheck plus the first transport tests.
6. Encrypt secrets at rest before any client data goes near this.
