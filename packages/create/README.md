# @kybernesis/create — the `kyb` CLI

One command from empty directory to a **governed, remembering, multiplayer,
self-testing** [eve](https://eve.dev) agent — plus the preflight and upgrade
tooling a forward-deployed engineer uses across an engagement's life.

```bash
npm create @kybernesis acme-atlas
# or, installed globally / via npx:
npx @kybernesis/create init acme-atlas
```

## `kyb init [name]`

Scaffolds the full Kybernesis stack:

1. `eve init` (pinned eve version) → base agent
2. Adds the Kybernesis registry + all four packages
   (`enterprise`, `arcana`, `multiplayer`, `evals`)
3. Prompts for display name, **department subagents**, and issuer — then
   generates each department: routing description, instructions, its own
   Arcana connection (per-dept workspace + key envs, eval-key fallback), and
   the three memory skills copied from the installed arcana package
4. Writes the identity instructions, the root memory mount
   (company/DM split + hermetic-eval key switching), the configured
   `evals/kybernesis.eval.ts`, `.env.example`, and the hermetic
   `npm run eval` script
5. Verifies: typecheck + `eve info` discovery
6. Prints the human-steps checklist (Arcana workspaces/keys, `vercel link`,
   the Slack connector browser flow, control-plane registration + grants,
   eval → deploy → the revoke demo)

Non-interactive (CI / agents): pipe stdin from `/dev/null` and pass the name —
all prompts take defaults (departments: finance, marketing, engineering).

## `kyb doctor`

Run inside an agent project. Checks, with pass/warn/fail per line:

- all four `@kybernesis/*` packages installed
- **every Arcana key↔workspace pair validated read-only against the live API**
  (200 / wrong-key 403 / missing-workspace 404, each with the fix)
- control-plane issuer JWKS reachable; `KYBERNESIS_AGENT` set
- Slack connector UID present
- `eve info` discovery clean
- the compiled `limits.maxInputTokensPerSession`, reported as explicit,
  explicit uncapped, inherited `40,000,000`, or unverifiable
- port 2000 free (a running dev server makes `eve eval` exit early)

Exit code 1 on any failure — usable as a CI preflight.

## `kyb upgrade [--skip-eval]`

Compares installed `@kybernesis/*` versions against npm, installs what's
behind, typechecks, then **runs the eval suite as the gate** — prints
"deploy" only on green. This is the maintenance-retainer loop as a command:
package improvement → `kyb upgrade` per client → green → `npx eve deploy`.

On self-hosted agents, upgrade also reconciles package-owned host artifacts. It
refreshes a stale `/etc/cron.daily/kyb-docker-prune` and an existing generated
systemd unit, warning before replacement and printing an exact manual repair
command if non-interactive sudo is unavailable. A missing systemd unit is not
created implicitly, and refreshing an existing unit does not restart the agent.

New `--host=exe` agents explicitly set
`limits: { maxInputTokensPerSession: 40_000_000 }`, freezing the certified Eve
0.49.0 effective default for subscription-backed sessions. Vercel templates do
not inject this setting. `kyb upgrade` reports the compiled effective value
read-only and never rewrites user-owned `agent/agent.ts`.

## Design notes

- **Zero runtime dependencies** — node builtins only (`spawnSync`, `readline`,
  global `fetch`). Nothing to audit, nothing to break.
- The scaffold pins the eve version the packages are developed against;
  upgrading eve is a deliberate, eval-gated step — not something a scaffold
  should do implicitly.
- Human steps stay human: Slack's browser flow, key creation, and admin grants
  can't be automated away — the CLI sequences everything around them and hands
  you the checklist. Don't promise zero-touch.
