# Kybernesis Platform — agent instructions

This is the **product monorepo** for Kybernesis: the packages that make
[eve](https://eve.dev) agent deployments enterprise-ready and uniquely
Kybernesis. Eve is the plumbing; this repo is the ecosystem/moat.

## Orient yourself first

0. **`docs/HANDOFF.md` — read FIRST on any machine that isn't Ian's main computer**:
   repo map (all sister repos + deploy targets), current versions, live-state
   snapshot, fresh-machine setup. The portable version of everything below.
1. **The master handoff doc** (Ian's main machine only — iCloud path):
   `/Users/ianborders/Library/Mobile Documents/iCloud~md~obsidian/Documents/kybernesis-system-overview.md`
   — business, full architecture, auth contract, shipped-vs-specced-vs-parked.
2. **The FDE runbook**: CANONICAL at
   `packages/create/skills/fde-engagement/references/playbook.md` (in this repo;
   the Obsidian copy is a mirror). Also browsable at company.kybernesis.ai/fde.
3. **Eve docs ship in this repo's node_modules**: `node_modules/eve/docs/` —
   read the relevant guide BEFORE authoring any eve capability
   (`extensions.md`, `tools/`, `channels/`, `evals/`, `connections/`,
   `reference/typescript-api.md`). Registry discovery: `npx eve registry list`.
   If docs are missing, run `npm install` at the repo root first.

## What lives here

| Path | What | Kind |
| --- | --- | --- |
| `packages/arcana` | Long-term memory (Arcana MCP + skills + recall-first instructions; opt-in eve memory slot `arcanaMemory()`) | **eve extension** (built with `eve extension build`) |
| `packages/enterprise` | Control-plane governance (`kybernesisAuth`, `channelIdentity`, surface header) | plain TS library (route auth can't ship in extensions) |
| `packages/manage` | Studio management routes (`/eve/v1/kyb/*`: info, sessions, surfaces, install, computer, setup) | plain TS library |
| `packages/local` | The agent works on the person's own machine through Studio (control-plane relay) | plain TS library |
| `packages/computer` | The agent's own computer (`DockerComputer`, `computerTool`, `open_browser`, `close_tabs`) | plain TS library |
| `packages/vault` | Per-person, per-agent vault (`list_vault`, `fill_from_vault`, `request_vault_item` helpers) | plain TS library; workflow tools written by the registry item |
| `packages/payments` | Link wallet spending (`approve_spend_request` helpers, `pay_on_computer`) | plain TS library; workflow tools written by the registry item |
| `packages/connectors` | Per-user connector tools from the control plane | plain TS library |
| `packages/dispatch` | Agent-to-agent delegation (`remotePeer`, `dispatchChannel`, governed edges) | plain TS library |
| `packages/identity` | `.agent` identity, peers as tools | plain TS library |
| `packages/exe` | Running on exe.dev VMs (subscription models, supervision, `hostPreflight`) | plain TS library |
| `packages/buzz` | Buzz channel bridge (runs as its own systemd unit) | **eve extension** + library |
| `packages/cards` | Rich replies: the card format tools emit and Studio draws, text fallbacks, the steps reader | plain TS library, zero deps (no eve peer) |
| `packages/notify` | Push notifications via the control plane | **eve extension** |
| `packages/artifacts` | Pages the agent makes for a person (reports, dashboards), drawn inline as cards in Studio and the phone; stored on the agent's machine, served per person by `manage` | **eve extension** + store library |
| `packages/voice` | Realtime voice (WebRTC, watch frames) | plain TS library |
| `packages/multiplayer` | Shared-thread Slack conversations (`multiplayerSlackChannel`) | plain TS library (channels can't ship in extensions) |
| `packages/evals` | Baseline QA suites (array-export fan-out factories, `kyb-eval` bin) | plain TS library |
| `packages/engineer` | Vision-verified dev loop (screenshot tool + trade-school skills) | **eve extension**; workshop sandbox ships via registry item (sandboxes are consumer-authored) |
| `packages/create` | The `kyb` CLI (init/doctor/upgrade/deploy/skills/tui) — zero runtime deps, node builtins only; ships the FDE skills | plain TS CLI (bin: `kyb`; pins the certified eve version for scaffolds (see EVE_VERSION in packages/create/src/util.ts)) |
| `fixtures/governed-ref` | Minimal governed agent; enterprise E2E harness | private fixture, never published |
| `registry/` | Source of https://registry.kybernesis.ai | static shadcn-format registry |

## Package conventions (hard-won — do not regress)

- **Plain-library packages**: `tsc -p tsconfig.build.json` with `rootDir: "src"`;
  relative imports MUST carry `.js` extensions (tsc does not rewrite specifiers;
  extensionless imports break plain-Node ESM consumers — shipped bug, fixed in
  enterprise 0.1.1).
- **Exports maps** always include `"./package.json": "./package.json"`.
- **Extensions** (arcana, artifacts, buzz, engineer, notify): source under `extension/`, built by
  `eve extension build`; extensions cannot declare channels, route auth,
  sandboxes, schedules, or evals — those ship as library exports or
  registry-written files instead.
- Every package: Apache-2.0 `LICENSE` + `NOTICE`, `files: ["dist","NOTICE"]`,
  `eve` as a **peerDependency** scoped to the eve line it was built on
  (`>=0.81.1 <0.82.0`) with the exact pinned version in `devDependencies`
  (currently **0.81.1**, matching `EVE_VERSION` in `packages/create/src/util.ts`;
  certified 2026-10-21 on host trials: Foreman 14 + 1 skip, Ava 16/16, Sid
  18/19, Kyber 20/23 (Sid-peer callback timeouts seen only in trials)).
  Upgrades are deliberate and eval-gated; see the certification skill. The
  first 0.81 boot deletes `.eve/.workflow-data` (past conversations); `kyb
  upgrade` copies it to `.eve/.workflow-data.eve-<old line>` first. 0.81
  dropped `load_skill`/`connection_search` (now `eve__skill`, `eve__search`,
  `eve__tool`), renamed the judge's `evaluationModel` to `decisionModel`, and
  withdraws `execute` asks on a steering message (HITL tools are `task()`).
  `@agent-browser/eve` does not mount on 0.81 and is no longer installed.
- **Per-eve-line builds**: a package belongs to the eve it was BUILT with, not
  its peer range. Before publishing, `npm install --no-save eve@^<line>` then
  `node scripts/check-eve-line.mjs`. A moved peer range alone ships a broken
  build (notify 0.1.5 took two agents down).
- **Workflow tools** (`"use workflow"`, `ctx.ask`) live in the consuming
  agent's `agent/tools/`, written by the registry item; packages export pure
  helpers only, and nothing in the driver bundle may import Node builtins.
- Tool-name matching is **by remote-name suffix**, never exact qualified names
  (mount namespace changes the prefix). See `packages/evals/src/tools.ts`.
- Eval fixture rules (encoded in `packages/evals`, explained in its README):
  in-test nonces, per-run unique keys, company-general wording, no security
  vocabulary, realistic delegation timeouts. Do not "clean these up."

## Release flow

1. Edit here → `npm run build` (root) → per-package `npm run typecheck`.
2. Bump the package version.
3. Publish. Ian publishes from his machine with browser 2FA (`ianborders`
   publishes new versions; only the **kybernesis** account can create new
   packages in the @kybernesis scope). Agents never publish: hand him the exact
   command, never with `--otp`. `scripts/prepublish.mjs` rebuilds `dist/` (it is not in git, so a stale one shipped manage 0.13.0 without its routes) and refuses a version
   already on npm. The packument shows about a minute before the tarball, so
   poll the tarball URL before deploying a consumer:
   `cd ~/platform/packages/<name> && git pull --ff-only && npm publish`
4. If install-time files changed, update the matching `registry/registry/*.ts`
   + regenerate `registry/r/<item>.json` (content-embedded copy) + the catalog
   `registry/r/registry.json` + `registry/index.html`, run
   `node scripts/check-registry.mjs`, then push to `master`. The root
   `vercel.json` serves `registry/` and auto-deploys from master (it can lag
   about 15 min). Never `vercel --prod`.
5. **Gate on the consumer**: bump the pin in the consuming agent, run its
   `npm run eval` (the suite must be green), then deploy that agent with its
   own `scripts/deploy.sh` (agents run on exe.dev VMs under systemd, not
   `eve deploy`). `kyb upgrade` never adds a package and only carries eve to
   the certified pin.

## Related repos (not here)

- `~/kyber` — our production agent; consumes these packages from npm; its eval
  suite is the release gate. Its Claude project memory
  (`~/.claude/projects/-Users-ianborders-kyber/memory/`) holds the deepest
  build history.
- `~/kybernesis-admin` — the control plane (prod: https://agent.kybernesis.ai).
  Additive-only migrations; `pnpm contracts:check` must stay green (daemon
  compatibility).
- `~/kyber-studio` — KYBER Studio, the Electron desktop client (device-flow
  sign-in, chat, Marketplace via `manage`, vault, the agent's computer). Git
  remote is `public`.
- `~/kyber-studio-mobile` — KYBER Studio on the phone (Expo).

## Don'ts

- Don't commit secrets; keys live in Vercel envs / `.env.local` (gitignored).
- Don't publish from a dirty tree; repo state must match npm.
- Don't add `eve` to a package's regular `dependencies`.
- Don't break the daemon contracts when touching anything control-plane-shaped.
- Don't name our own agents or any competitor anywhere in these packages,
  their docs, tests or fixtures; they ship to enterprises. Use generic roles
  (`planner`, `field-ops`) and anonymise captured fixtures.
