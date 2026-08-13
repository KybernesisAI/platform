# Gaps — what is built, what is untested, what is missing

State of the connector/MCP/Studio work as of 2026-08-14. Ordered by what would
hurt a paying client first, not by how interesting it is to fix.

Three categories, and the middle one is the dangerous one:

- **Missing** — known absent, nobody is surprised.
- **Built but unverified** — code exists, typechecks, has never completed a real
  run. Every expensive failure so far came from this column.
- **Verified** — watched working end to end.

---

## Verified

- Gmail and Google Calendar through Composio; real answers from both.
- Plaud local MCP: connected, 7 tools, answered through the relay.
- Local execution: read/list/search/run on the user's own machine.
- Routines created from chat, applied, restarted, fired.
- Control-plane identity: device flow, grants, agent credential, standing grant.
- Encryption at rest, deployed, with existing rows sealed on deploy.
- Sid's eval suite: 12 passed, 29 gates — on Grok, on the subscription.
- Signed, notarized macOS build with a working in-app update control.
- Sid under version control, local and GitHub in one history.

## Built but unverified

1. **Remote MCP (`mcp-direct`) end to end.** Routes, storage, an MCP client that
   handles both JSON and SSE, and a Check that runs the handshake from the
   control plane. No remote server has ever answered.
2. **Unattended connector runs.** A schedule has no signed-in user and gets the
   shared principal. Never exercised; the first symptom would be a morning
   briefing that silently does nothing.
3. **Studio's dead-man's switch and dispatch deadline.** Written after the
   wedges, never seen firing.
4. **The Grok credential refreshing unattended.** It expires every six hours and
   the CLI refreshes it in place. If nobody runs `grok` on that VM for a day,
   does it still hold? Unknown, and it would present as the agent "breaking".

## Missing — client-facing

5. **Tool volume is unmanaged.** Gmail (23) plus Calendar (28) is 51 tool
   definitions in every prompt, from two services. Real tokens per turn and
   measurably worse selection. Curated top-N plus an escape hatch is the
   proposal; it needs an eval across flat / two-level / hybrid first.
6. **Connector tool schemas are thin where the broker's list view is thin.**
   Watching Sid call Plaud: nine attempts to pass a `file_id` the published
   schema never mentioned, guided only by error messages. Two fixes: fetch the
   per-tool definition rather than the list entry, and feed a failed call's
   error back into the session so the next attempt knows.
7. **`eve-connect` is unimplemented.** It is the answer for a client who refuses
   a fourth party holding their tokens, and today it is only a `provider` value
   on a card.
8. **No admin screen for the connector catalog.** The ten are seeded; an org
   cannot add an eleventh or hide one without SQL.
9. **Nothing shows which machine a local MCP server is on.** They are per-device
   by design; a second Mac silently has a different set.

## Missing — operational

10. **The VM cannot reach its own repo.** Deploy keys are disabled at the
    KybernesisAI org, so Sid's machine can neither pull nor push. A routine
    written from chat is an uncommitted change on a disk. Needs the org policy
    changed or a fine-grained PAT. *(Parked deliberately.)*
11. **Two server processes keep appearing on Sid.** `restart.sh` asserts exactly
    one and passes; something respawns afterwards, most likely exe.dev's own
    supervisor racing the script. Two servers on one durable store is the
    condition that strands sessions — the root cause behind a whole evening of
    "nothing is happening", and still unexplained.
12. **No tests for the transport.** The send path broke five distinct ways in one
    evening. Every fix was verified by hand.
13. **`npm ci` cannot be used in CI.** The lock is written by npm 11 locally and
    the runner ships npm 10; they resolve one transitive range differently, so
    the pipelines run `npm install`. Reproducibility traded for a pipeline that
    runs. Pinning the runner's npm major would fix it properly.
14. **Local `.dmg` packaging needs python**, which this machine lacks.
    `--mac dir` sidesteps it for the pre-release launch check.
15. **Sid has no monitoring.** A stranded session, a dead turn, or a failed
    restart is found by a person noticing.
16. **Publishing is manual.** Every package needs a human at an npm browser
    prompt, and it has repeatedly been the slowest step in a fix.

## Missing — security and governance

17. **Two consent systems that cannot revoke each other.** The control plane
    holds a standing per-device grant; Studio holds per-effect permissions in a
    local file. Revoking in one does not revoke the other.
18. **Reaching a desktop is still not its own capability.** "May talk to this
    agent" and "may run commands on my laptop" remain one decision.
19. **Local execution runs in Studio's main process**, not a supervised daemon.
    A bug there takes the window with it.
20. **No audit trail for connector use.** Who ran which tool against whose
    account is not recorded anywhere a client could review.

## Known-and-accepted

- A restart strands an in-flight turn; eve does not resume a killed step.
  Mitigated, not solved.
- Composio holds refresh tokens for a client's Google and Slack — a fourth
  party. Item 7 is the answer for a client who refuses.
- Composio bills per action, and an agent in a loop is not a person clicking.
- **Models are unreliable about their own identity.** Sid claimed to be "Claude
  Opus 4.6, Anthropic" while running Grok, and attributed it to an instruction
  that does not exist anywhere in its context. Worth knowing before a client
  asks the same question in a demo.

---

## What I would do next, in order

1. The tool-volume eval, then curation. It is now concrete: 51 definitions from
   two services, and every connector added makes it worse.
2. Per-tool schemas (item 6). The Plaud retry loop is the evidence.
3. Verify the unverified column — remote MCP, unattended runs, the watchdog.
4. Find what respawns Sid's second server (item 11). It is the oldest unexplained
   thing here and it caused the worst symptoms.
