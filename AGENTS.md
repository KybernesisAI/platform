# Kybernesis Platform — agent instructions

This is the **product monorepo** for Kybernesis: the packages that make
[eve](https://eve.dev) agent deployments enterprise-ready and uniquely
Kybernesis. Eve is the plumbing; this repo is the ecosystem/moat.

## Orient yourself first

1. **The master handoff doc** (read once per session if you lack context):
   `/Users/ianborders/Library/Mobile Documents/iCloud~md~obsidian/Documents/kybernesis-system-overview.md`
   — business, full architecture, auth contract, shipped-vs-specced-vs-parked.
2. **The FDE runbook** (how these packages are used in a client engagement):
   `.../kybernesis-engagement-playbook.md` in the same Obsidian folder.
3. **Eve docs ship in this repo's node_modules**: `node_modules/eve/docs/` —
   read the relevant guide BEFORE authoring any eve capability
   (`extensions.md`, `tools/`, `channels/`, `evals/`, `connections/`,
   `reference/typescript-api.md`). Registry discovery: `npx eve registry list`.
   If docs are missing, run `npm install` at the repo root first.

## What lives here

| Path | What | Kind |
| --- | --- | --- |
| `packages/arcana` | Long-term memory (Arcana MCP + skills + instructions) | **eve extension** (built with `eve extension build`) |
| `packages/enterprise` | Control-plane governance (`kybernesisAuth`) | plain TS library (route auth can't ship in extensions) |
| `packages/multiplayer` | Shared-thread Slack conversations (`multiplayerSlackChannel`) | plain TS library (channels can't ship in extensions) |
| `packages/evals` | Baseline QA suites (array-export fan-out factories) | plain TS library |
| `fixtures/governed-ref` | Minimal governed agent; enterprise E2E harness | private fixture, never published |
| `registry/` | Source of https://registry.kybernesis.ai | static shadcn-format registry |

## Package conventions (hard-won — do not regress)

- **Plain-library packages**: `tsc -p tsconfig.build.json` with `rootDir: "src"`;
  relative imports MUST carry `.js` extensions (tsc does not rewrite specifiers;
  extensionless imports break plain-Node ESM consumers — shipped bug, fixed in
  enterprise 0.1.1).
- **Exports maps** always include `"./package.json": "./package.json"`.
- **Extensions** (arcana): source under `extension/`, built by
  `eve extension build`; extensions cannot declare channels, route auth,
  sandboxes, schedules, or evals — those ship as library exports or
  registry-written files instead.
- Every package: Apache-2.0 `LICENSE` + `NOTICE`, `files: ["dist","NOTICE"]`,
  `eve` as wildcard **peerDependency** with the pinned dev version in
  `devDependencies` (currently 0.29.5 — upgrades are deliberate, eval-gated;
  eve 0.30.x exists).
- Tool-name matching is **by remote-name suffix**, never exact qualified names
  (mount namespace changes the prefix). See `packages/evals/src/tools.ts`.
- Eval fixture rules (encoded in `packages/evals`, explained in its README):
  in-test nonces, per-run unique keys, company-general wording, no security
  vocabulary, realistic delegation timeouts. Do not "clean these up."

## Release flow

1. Edit here → `npm run build` (root) → per-package `npm run typecheck`.
2. Bump the package version.
3. Publish (needs Ian's browser auth as the **kybernesis** npm account — only
   that account can create new packages in the @kybernesis scope; new
   packages/versions take 1–3 min to propagate to anonymous reads):
   `npm publish /Users/ianborders/platform/packages/<name> --access public`
4. If install-time files changed, update the matching `registry/registry/*.ts`
   + regenerate `registry/r/<item>.json` (content-embedded copy) + the catalog
   `registry/r/registry.json` + `registry/index.html`, then deploy:
   `cd /Users/ianborders/platform/registry && vercel deploy --prod --yes --scope ian-darkstarvccs-projects`
5. **Gate on the dogfood**: bump the pin in `~/kyber`, run `npm run eval` there
   (the baseline suite must be green), then `npx eve deploy` kyber.

## Related repos (not here)

- `~/kyber` — our production agent; consumes these packages from npm; its eval
  suite is the release gate. Its Claude project memory
  (`~/.claude/projects/-Users-ianborders-kyber/memory/`) holds the deepest
  build history.
- `~/kybernesis-admin` — the control plane (prod: https://agent.kybernesis.ai).
  Additive-only migrations; `pnpm contracts:check` must stay green (daemon
  compatibility).
- `~/eve-studio` — Electron desktop client (sign-in via control-plane device
  flow is specced in the Desktop brief, not built).

## Don'ts

- Don't commit secrets; keys live in Vercel envs / `.env.local` (gitignored).
- Don't publish from a dirty tree; repo state must match npm.
- Don't add `eve` to a package's regular `dependencies`.
- Don't break the daemon contracts when touching anything control-plane-shaped.
