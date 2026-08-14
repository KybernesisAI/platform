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
- The remote MCP client against a real public server (see item 1).
- **Kyber ↔ Sid, agent to agent, end to end.** Edges granted in the admin, a
  300s A2A token minted from the caller's own credential, the callee resolved
  from the registry, and Kyber relaying Sid's answer verbatim. Both directions
  of the governance check seen: `edge_not_granted` before the grant, a real
  answer after it.
- **Studio's agent-to-agent rendering**, against the recorded stream from that
  exchange (`kyber-studio/test/fixtures/a2a-kyber-sid.jsonl`, five tests).
- **The Grok credential self-healing** from a forced expiry, mid-turn.
- **Studio's agent-to-agent rendering**: a collapsed line naming the peer, the
  exchange opening as its own view-only conversation, and the peers a control
  plane has granted listed in the agent panel.
- Kyber on current packages: enterprise 0.4, engineer 0.3, plus connectors,
  local and manage. Its eval suite passed on the upgrade — 10 passed, 22 gates.
- Sid's suite green again on 2026-08-14 after the MCP schema fix and an env
  cleanup: 11 passed, 1 scored, 29 gates, 5m19s, on the Grok subscription.

## Built but unverified

1. **Remote MCP (`mcp-direct`) — the client half is now verified, the route half
   is not.** Against a real public server (`https://mcp.deepwiki.com/mcp`,
   2026-08-14): handshake, `tools/list` returning 3 tools with schemas,
   `toolInputSchema` translating one of them (including an `anyOf` it does not
   model, which stays permissive rather than refusing), and a real
   `read_wiki_contents` call returning content. So the transport, the session
   header, and the JSON/SSE parsing work.

   What is still unproven: the control-plane routes that store a server and the
   agent-side path that turns one into tools a deployed agent calls. Not run
   because both need a signed-in principal. The remaining risk is storage and
   plumbing, not the protocol.
2. **Rooms: a multi-hop hand-off.** Group conversations are built — addressing,
   catch-up context on hand-off, per-member queueing, a watchdog, a stop
   control, pin and delete. What has NOT been watched is a real three-agent
   chain (planner → designer → engineer), or whether the catch-up text lands
   usefully in the third agent's context. Two agents in a room has been seen;
   the interesting case has not.
3. **Unattended connector runs.** A schedule has no signed-in user and gets the
   shared principal. Never exercised; the first symptom would be a morning
   briefing that silently does nothing.
4. **Studio's dead-man's switch and dispatch deadline.** Written after the
   wedges, never seen firing.
~~**The Grok credential refreshing unattended.**~~ **Answered: it does not,
   and it took Sid down.** The token expired at 22:40 and the failure surfaced
   at 04:05 as `The OAuth2 access token could not be validated` — a 403 from
   the model API with no mention of expiry. The refresh token was always there;
   only the CLI exchanges it, and nothing was running the CLI.
   `@kybernesis/exe` 0.5.0 renews inside fifteen minutes of expiry by running
   `grok models`, debounced. Verified by forcing the expiry into the past:
   healed in five seconds, turn completed. **Publish pending.**

## Missing — client-facing

5. **Tool volume is unmanaged.** Gmail (23) plus Calendar (28) is 51 tool
   definitions in every prompt, from two services. Real tokens per turn and
   measurably worse selection. Curated top-N plus an escape hatch is the
   proposal; it needs an eval across flat / two-level / hybrid first.
6. ~~**Connector tool schemas are thin.**~~ **Fixed, and it was ours.** The
   published schema was never thin: Plaud's `get_file` declares a required
   `file_id` *with a description*. `localMcpTools()` read `tools/list` for names
   and descriptions and threw the `inputSchema` away, handing the model an open
   object — so nine calls guessing an argument name that was in the payload the
   whole time. `@kybernesis/local` 0.5.0 translates it (`mcpInputSchema`, six
   tests against Plaud's real schemas). Published and running on Sid. The
   one-attempt-instead-of-nine still wants a human turn in Studio to watch.
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
11. ~~**Two server processes keep appearing on Sid.**~~ **Closed. There was
    never a second server — the measurement was wrong.**

    `pgrep -fc 'server/index.mjs'`, run over ssh, matches the *shell running the
    pgrep*: the pattern is right there in its own command line. It reports 2 and
    there is 1. Proven by listing what it matched:

    ```
    46447: /usr/bin/node /home/exedev/sid/.output/server/index.mjs
    46488: bash -c ... pgrep -f 'server/index.mjs' ...   ← the shell asking
    ```

    This is the same error as `pkill -f` killing its own caller in Studio, and
    it cost far more here because it manufactured a phantom to chase. `ps -eo
    pid,ppid,args` and read it, or exclude `$$`. `restart.sh` was right all
    along — it runs as `bash restart.sh`, so its own command line does not
    contain the pattern and its assertion is sound.

    Two real bugs were fixed on the way: the lock leaking to the child (`9>&-`),
    and test harnesses being killed mid-restart by ssh's SIGHUP. Both were worth
    fixing; neither was the thing being investigated. A concurrent race, run
    detached:

    ```
    ssh <host> "setsid nohup bash ~/restart.sh >/tmp/r1.log 2>&1 </dev/null & \
                sleep 3; setsid nohup bash ~/restart.sh >/tmp/r2.log 2>&1 </dev/null &"
    ```

    Both completed (pid=46002, pid=46127) and both asserted a single server.
    There is no supervisor: process ancestry is `npm exec eve start → sh -c →
    node .bin/eve → server/index.mjs`, one chain. **Anything that restarts Sid
    must detach** (`setsid nohup … </dev/null &`), or ssh's SIGHUP becomes the
    bug you go looking for.
12. ~~**A restart could serve a stale build.**~~ **Fixed.** `restart.sh`
    proved the PROCESS started after the BUILD, which says nothing about whether
    the build reflects the SOURCE. Sid spent a day serving a build ten hours
    older than its files while reporting "OK: serving the current build". It now
    builds when the source has moved and refuses to restart into a failed build.

    This was worse than it sounds: `@kybernesis/manage` calls this script after
    writing files, so **every install from KYBER Studio reported success and
    changed nothing.**
**Transport tests have started.** The peer reader is its own Electron-free
    module with five tests over a recorded production stream. The rest of the
    send path — dispatch deadline, silence watchdog, 401 refresh, session
    recovery — is still verified by hand only.
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
2. Verify the unverified column — remote MCP, unattended runs, the watchdog.
   These are the last places where "it typechecks" is standing in for "it ran".
3. Automate publishing (item 15). It has now blocked a finished fix twice.

## Needs Ian, exactly

- **Grant the two A2A edges** at https://agent.kybernesis.ai/agents. The form is
  per-callee — "Agent-to-agent edges (who may CALL this agent)":
  - open **sid**, allow calls from **Kyber**;
  - open **Kyber**, allow calls from **sid**.
  Names are case-sensitive. Until then the mint returns `edge_not_granted`.
- **Publish two packages**: `@kybernesis/multiplayer@0.2.0` (refusePublic) and
  `@kybernesis/local@0.6.0` (the tool guard). Kyber's local tools stay ungated
  in Slack channels until both are on npm.
- One Plaud question to Sid in Studio, to watch the schema fix land.
