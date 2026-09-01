---
description: Use when installing, configuring, or debugging any @kybernesis package — arcana (memory), enterprise (governance), multiplayer (Slack), buzz (workspace member), engineer (build+ship), dispatch (agent-to-agent), connectors (Gmail/Calendar/remote MCP), local (the user's own machine), manage (Studio→agent), exe (off-Vercel hosting), evals (QA), create (kyb CLI) — or the Kybernesis registry. Includes every production-learned gotcha.
---

# The Kybernesis packages

Twelve packages, npm-public under `@kybernesis`, Apache-2.0, monorepo
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
  KYBERNESIS_ISSUER. Also `channelIdentity({ issuer, credential })` — resolves a
  chat sender (provider + platform id) to a session minted FOR THAT PERSON, per
  turn, so a bridge never holds durable credentials for anybody. THROWS when the
  control plane is unreachable rather than refusing: a 500 read as "not allowed"
  locks a whole room out over a deploy. See the `control-plane` skill.
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
  **GOVERNED mode (≥0.2.1, proven live 2026-08-07):** `remotePeer({ callee:
  "<registered-name>", governed: { issuer } })` + `dispatchChannel({ governed:
  { issuer, agent } })` — edges granted in the control plane, outbound auth =
  a 300s A2A token minted from POST /api/agent/session with the deployment's
  `KYBERNESIS_AGENT_CREDENTIAL`, callee URL from the registry (envVar
  overrides). Revoke in the admin → refused within the token TTL, no
  redeploy. Names match EXACTLY (case-sensitive: "Kyber" ≠ "kyber").
  Requires @kybernesis/enterprise ≥0.2.0 installed (optional peer, lazy).
  0.2.1 lesson: eve resolves remote URLs at BOOT — url() must degrade
  (env → discovery-if-credentialed → fallbackUrl), never throw on a missing
  credential, or the whole agent (and its evals) fails to boot.
- **connectors** — the user's SaaS accounts, brokered. `connectorTools()` is a
  dynamic resolver: at turn start it asks the control plane which services THIS
  principal has connected and returns those tools. Composio is the broker; the
  API key is per-org, held in the control plane (never an env var, never a
  client's key in our account). Tools are named `<toolkit>_<action>`. Also
  exports `toolInputSchema` (broker JSON Schema → zod) and a minimal MCP client
  for `mcp-direct` servers that speaks BOTH JSON and text/event-stream.
- **local** — the user's own machine, through KYBER Studio. `localShellTool`,
  `localRead/List/Write/Edit/SearchTool`, plus `localMcpTools()` for MCP servers
  running on that machine, relayed. Every effect is consented in Studio; the
  agent never holds a shell. `LOCAL_INSTRUCTIONS` explains the arrangement to
  the model — mount it or the agent will offer to do things it cannot do.
- **manage** — the other direction: `manageChannel()` lets Studio install
  capabilities and write schedules onto a running agent, and `routineTools()`
  turns "every morning at 8, brief me" into a real schedule file. This is how a
  routine gets created from chat without anyone touching the repo.
- **exe** — running off Vercel. `exeModel()` for exe.dev's LLM integration,
  `grokSubscription()` / `readGrokCredential()` for a SuperGrok or X Premium+
  login (`grok login` → `~/.grok/auth.json`, a valid bearer for api.x.ai —
  same shape as eve's `experimental_chatgpt()`), `hostPreflight()`, Photon
  iMessage credentials, and a `/preview` tool. Subpaths: `/slack`, `/photon`,
  `/sandbox`, `/preview`. See the `self-hosting` skill.
- **buzz** — the agent as a MEMBER of a Buzz workspace (not a bot bolted on).
  `buzzBridge()` + a `kybernesis-buzz` CLI (`init` prints the key to invite ·
  `run` · `service` writes a systemd unit · `id` converts npub↔hex). Each turn
  runs as the sender, resolved via `channelIdentity`; an unknown sender is sent
  a sign-in link **privately** — holding it is what proves control of the
  account, so a link posted in a room lets anyone there claim to be that person.
  Publishes presence (20001, 60s heartbeat), typing (20002, every 3s) and 👀
  (kind 7). Wire gotchas: reactions and dm-open go over HTTP with NIP-98 auth,
  NOT the socket (a socket reaction is accepted and then never appears), and
  command acks come back as `response:{…}` — parse without stripping that prefix
  and a working call reads as a failure.

- **evals** — QA. `kybernesisBaseline({ agentDisplayName, routing, engineer?,
  safety? })` = smoke + 5 memory + 1 safety (quoted content is data, on by
  default) + routing per dept + optional engineer pair (vision loop, push-to-main
  refusal). Judge model ≠ model under test. Hermetic runs force all workspaces to
  `<name>-eval` via the npm script.
- **create** — the `kyb` CLI, and the whole lifecycle of an agent:
  `init` (scaffold; `--host=exe` also installs the hardened restart script),
  `register` (control plane, via device flow — no admin session, no pasted
  token, grants the person who ran it, idempotent by name),
  `deploy` (copy + install + restart + PROVE it; `eve deploy` on Vercel),
  `doctor`, `upgrade` (carries eve to the Kybernesis-CERTIFIED pin, never
  blind latest), `skills`. Ships THIS skill suite.

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
  rewrite); eve is a peer dep with an explicit range (`>=0.47.0 <0.48.0`),
  pinned exactly in devDeps.
- **Eval fixtures are hardened on purpose** — in-test nonces (eve caches
  compiled eval modules), per-run unique keys (workspaces accumulate),
  company-general wording (dept-flavored prompts delegate and hide tool
  calls), no security vocabulary ("canary" triggers refusals), long routing
  timeouts. Do not "clean up" the odd-looking patterns.
- **A per-turn dynamic resolver needs a deadline.** `connectorTools()` and
  `localMcpTools()` run before every turn and reach across a network. Without a
  budget (6s) and a cache (60s connectors, 5min local discovery) one unreachable
  laptop makes every turn hang — the agent looks broken and nothing in the log
  says why.
- **Composio: one request per toolkit.** Repeating `toolkit_slug` in a single
  `/api/v3/tools` call returns an EMPTY list, so connecting a second service
  silently emptied the first. The logo is at `meta.logo`, not `logo`. A 200 can
  still carry `successful: false` — check the body, not the status.
- **The broker's entity is the agent's REGISTERED name**, not its UUID.
  `<agent>:<userId>`. Studio knows agents by id; normalize before you ask the
  broker, or a connected account looks unconnected.
- **MCP requires the handshake.** `initialize` AND `notifications/initialized`
  before `tools/list`, or the server never answers. Spawn through a LOGIN shell
  (a bare spawn misses the user's PATH and node) and always bind
  `child.on("error")` — without it a failed spawn is an unhandled rejection
  that takes the process, not a error message.
- **Translate the MCP/broker inputSchema — never pass an open object.** A tool
  with no declared arguments makes the model guess: nine calls to find a
  `file_id` the server had documented all along. `mcpInputSchema` (local) and
  `toolInputSchema` (connectors) do this; keep them permissive where the server
  says nothing.
- **Never wrap a model object in a Proxy.** The AI SDK's model methods depend on
  their own `this`; intercepting them detaches it and every call dies inside the
  SDK on a missing internal. To swap a credential, wrap `fetch` instead — and
  re-read the credential per request: a Grok login expires in six hours and the
  CLI refreshes it in place.
- **Credentials are never a user's problem.** No client ever puts a key in a
  `.env` — broker keys live per-org in the control plane, encrypted at rest, set
  through an admin screen. A design that ends in "paste this token" is wrong.
- **npm**: only the `kybernesis` account creates new packages in the scope;
  publishes need the human's browser auth; new versions take 1–3 min to
  propagate to anonymous reads.
