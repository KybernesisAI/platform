---
description: Use when building out an eve agent — adding channels (Slack, iMessage, Telegram, Discord…), connections to client systems, agent skills, model pinning, instructions, or testing in eve dev. The how-to for every eve authoring surface.
---

# Building eve agents

**The prime rule: read the pinned docs before writing eve code.** The
installed framework docs are the source of truth for THIS project's version:
`node_modules/eve/docs/` (README.md indexes them). Never author a channel,
connection, sandbox, or schedule from memory — read its doc page first.
Fallback when docs are absent: https://eve.dev/docs.

## The loop

`read the doc → write the file → npx eve info (0 diagnostics) → test a turn
in npx eve dev → eval`. Every authoring task follows it.

## Model (agent/agent.ts)

`defineAgent({ model })`. No agent.ts → defaults to anthropic/claude-sonnet-5;
once the file exists, `model` is required. String = Vercel AI Gateway id
(`anthropic/claude-opus-4.8`, dot version) — the client-deploy default.
Direct provider: install `@ai-sdk/<provider>`, pass `anthropic("claude-opus-4-8")`
(hyphen version) + provider key in env. Dynamic per-principal selection via
`defineDynamic({ fallback, events })` — prefer `session.started` scope (prompt
caches are per model). Docs: `agent-config.md`.

## Channels (agent/channels/, one file per surface)

Filename = channel id. eve normalizes every surface into one runtime — tools/
instructions/memory never change per channel. Available: Slack, Photon
(iMessage), Telegram, Discord, Teams, Twilio (SMS/voice), GitHub, Linear,
web (eve HTTP + useEveAgent), custom (`defineChannel`). Install:
`eve add channel/<name>` (e.g. `channel/photon-imessage`, `channel/telegram`).

Setup is always three steps: (1) the channel file, (2) provider-side
credentials in env — the HUMAN runs anything with a browser login, (3) point
the provider at the mounted route (`/eve/v1/<channel>`). Each channel's doc
page (`docs/channels/<name>.mdx`) has the complete recipe including webhook
registration and HITL behavior. For Kybernesis Slack deploys use
`@kybernesis/multiplayer` (group semantics) — see the `kybernesis-packages`
skill.

## Connections (agent/connections/)

Search before writing: `eve registry list` / `search <term>` / `view <item>`
/ `add <item>` (setup flows resume via `eve add <item> --skip-install`).
Hand-author only for client-internal services. Two shapes: MCP server →
`defineMcpClientConnection`; OpenAPI 3.x doc → `defineOpenAPIConnection`.
Four auth modes: static token (`auth.getToken` from env — pilot default),
Vercel Connect user-scoped (`connect("<connector-UID>")` — UID not short
name; first use posts an OAuth link in-thread, turn parks + resumes), Connect
app-scoped (`connect({connector, principalType:"app"})` — non-interactive),
or none. Connector provisioning is CLI-able:
`vercel connect create <service> --name <n>` + `vercel connect attach <uid> --yes`.
Subagents have NO user principal — static or app-scoped only. Write the
connection `description` as a capability naming the systems; decide surface
gating (fail-closed) and `approval` gates per connection at install time.
Docs: `docs/connections/*`.

## Skills (agent/skills/)

On-demand procedures (model calls `load_skill` when the description matches).
Forms: flat `.md` (first line = routing description) → packaged dir with
`SKILL.md` (+`references/`, description frontmatter required) → `defineSkill`
(only for typed/generated content). The description is a ROUTING HINT — write
it as the triggering task ("Use when…") and test by asking without naming the
skill. Scoped per agent: subagents need their own copies (or subagent-local
extension mounts that ship them). Community marketplace: skills.sh — included
in `eve registry search`; install `eve add @skills/<owner>/<repo>/<name>`;
ALWAYS review the diff before running. Docs: `docs/skills.mdx`.

## Instructions (agent/instructions.md or instructions/)

Always-on context: identity, tone, standing rules ONLY — procedures go in
skills. Directory entries combine alphabetically (root file first); `.ts`
entries wrap `defineInstructions` (compile-time) or `defineDynamic`
(per-session, e.g. surface-aware greetings). Draft with Claude from discovery
notes, then judge by test (eve dev turns + evals), never by reading.

## Subagents (agent/subagents/<id>/)

Inherit NOTHING. Own tools/skills/connections/instructions/sandbox; on eve
≥0.30 also OWN extension mounts (`subagents/<id>/extensions/` — mounts only
into that subagent). No channels/schedules; no user principal; whole job must
fit one delegation call. Docs: `docs/subagents.mdx`.

**Sandbox layout trap:** a FLAT `agent/sandbox.ts` is discovered but scopes to
the ROOT agent only — subagents silently fall back to the default backend
chain (Docker → microsandbox → just-bash), which surfaces as
`opening sandbox session "subagents/<id>" on backend "docker"` in eval logs.
Use the directory form `agent/sandbox/sandbox.ts` — that one is app-level and
subagents get it free. (Cost a debugging session on eve-gtm, 2026-08-07.)

**Parallel same-subagent delegation collides** (`Session … lost
continuationToken … to session …`, failed subagent-result actions): two
delegations to the SAME subagent fired in one step race on child sessions.
Instruct serial delegation ("one draft at a time, wait for each result").

## Test in eve dev

`npx eve dev` boots the local runtime + chat TUI. Walk: identity → skill
routing (watch load_skill) → delegation → memory round-trip → (engineer)
screenshot turn. Local principal counts as a DM surface. Kill the dev server
before `npm run eval`. The TUI is NOT the deployed agent — redeploy after
every change.
