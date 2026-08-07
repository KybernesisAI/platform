---
description: Use when installing, configuring, or debugging any @kybernesis package — arcana (memory), enterprise (governance), multiplayer (Slack), engineer (build+ship), dispatch (agent-to-agent), evals (QA), create (kyb CLI) — or the Kybernesis registry. Includes every production-learned gotcha.
---

# The Kybernesis packages

Seven packages, npm-public under `@kybernesis`, Apache-2.0, monorepo
`KybernesisAI/platform`. Registry: `https://registry.kybernesis.ai`
(`eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json`,
then `eve add @kybernesis/<item>`). Each covers one axis:

- **arcana** — memory. Extension mount `arcana({ apiKey, workspace,
  resolveWorkspace? })`. Workspace-scoped `kb_` keys (403 outside their
  workspace — one key per brain). `resolveWorkspace` only from VERIFIED
  session context, never model output, and only key-reachable workspaces.
  Subagents: local extension mount (`subagents/<id>/extensions/arcana.ts`,
  eve ≥0.30) or plain connection + skill copies. Header
  `X-Kyberagent-Agent: <workspace>` required by the MCP.
- **enterprise** — governance. Plain library (route auth can't ship in an
  extension). `kybernesisAuth()` admits only control-plane IdentitySessions
  WITH a grant for this agent (`authorization: Bearer` + `x-kybernesis-bundle`
  headers; 401 no-creds, 403 agent_not_granted). Lazy JWKS — compiles without
  KYBERNESIS_ISSUER. See the `control-plane` skill.
- **multiplayer** — Slack conversation mechanics. `multiplayerSlackChannel()`
  from `/slack` subpath: thread = shared session with per-speaker verified
  identity, no-re-mention continuation, dual surface (verified
  `surface: "channel"|"dm"` attribute + helpers from package root), `/new` DM
  reset. Slack-only today.
- **engineer** — build + ship. Extension: `screenshot` (renders in in-sandbox
  Chromium, returns pixels the model SEES) + `deliver` (sandbox file → public
  Blob URL; needs BLOB_READ_WRITE_TOKEN — one-liner:
  `vercel blob create-store <name>-deliverables --access public --yes`) +
  six skills (dev-loop, scaffold, visual-qa, git-discipline, ship,
  architecture-notes). The registry item ALSO writes
  `agent/sandbox/sandbox.ts` — the workshop: Playwright baked into the
  template at DEPLOY time, backend PINNED to Vercel Sandbox (no Docker
  anywhere, local runs use hosted sandboxes via `vercel link` + `env pull`),
  domain allowlist = the client's security posture. Ship loop: preview deploys
  via the Vercel MCP connection (inline file tree, no git needed, no token in
  the VM); production promotion is ALWAYS human-approved.
- **dispatch** — agent-to-agent. `remotePeer({ envVar, description })` under
  `agent/subagents/` = a separately DEPLOYED eve agent as a callable peer
  (eve's `defineRemoteAgent` underneath: durable park→callback dispatch);
  `dispatchChannel({ trustedPeers, extraAuth? })` as `agent/channels/eve.ts` =
  the receiver, one declaration feeding BOTH the OIDC subjects allowlist and
  `trustedForwarders`. Principal forwarding ON by default — the peer runs as
  the human who asked. `() => true` trust is not expressible. Peers are
  production-environment by default. BOTH ends must run compatible eve
  versions (old receivers silently drop forwarding → service identity).
  Composes with enterprise via `extraAuth: [kybernesisAuth(...)]`. See the
  `connect-agents` skill for the end-to-end wiring flow.
- **evals** — QA. `kybernesisBaseline({ agentDisplayName, routing,
  engineer? })` = smoke + 5 memory + routing per dept + optional vision-loop
  eval. Judge model ≠ model under test. Hermetic runs force all workspaces to
  `<name>-eval` via the npm script.
- **create** — the `kyb` CLI: `init [--engineer]`, `doctor`, `upgrade`
  (carries eve to the Kybernesis-CERTIFIED pin, never blind latest),
  `skills`. Ships THIS skill suite.

## Gotchas that each cost a real debugging session

- **Tool names are mount-dependent — ALWAYS suffix-match.** Extension mount →
  `arcana__memory__arcana_remember`; plain connection → `arcana__arcana_remember`.
  In approvals/hooks/evals: `toolName.endsWith("arcana_remember")`.
- **Vercel Connect connectors: use the UID** (`mcp.vercel.com/vercel`), never
  the short name, in `connect()`. No grant editor exists — changing scope =
  detach → remove → create (same UID) → attach, then re-auth from a FRESH
  session (stale sessions error without re-prompting).
- **Dev servers in the sandbox start DETACHED** (nohup + background + log +
  curl-poll) — a foreground server blocks the tool call and hangs the turn.
  Verified-and-unchanged builds deploy WITHOUT re-running a server.
- **Deliver/file links: post URLs as plain text** — markdown bold glues
  asterisks onto the URL in Slack and breaks it. Coach agents in prose, not
  shell (WAFs eat shell-syntax Slack messages).
- **ESM packaging**: relative imports need `.js` extensions (tsc doesn't
  rewrite); eve is a peer dep with an explicit range (`>=0.30.0 <0.31.0`),
  pinned exactly in devDeps.
- **Eval fixtures are hardened on purpose** — in-test nonces (eve caches
  compiled eval modules), per-run unique keys (workspaces accumulate),
  company-general wording (dept-flavored prompts delegate and hide tool
  calls), no security vocabulary ("canary" triggers refusals), long routing
  timeouts. Do not "clean up" the odd-looking patterns.
- **npm**: only the `kybernesis` account creates new packages in the scope;
  publishes need the human's browser auth; new versions take 1–3 min to
  propagate to anonymous reads.
