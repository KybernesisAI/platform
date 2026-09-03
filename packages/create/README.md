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

Non-interactive (CI / agents): pass the name and `--yes`; omitted options use
the documented defaults.

### Model reach

The default route is unchanged: Vercel scaffolds author an AI Gateway model id,
and exe scaffolds use `exeModel()` plus `EXE_MODEL` for the VM's attached LLM
integration.

To bill model calls to a Claude subscription instead of the exe gateway:

```bash
kyb init acme-atlas --host=exe --model-reach=claude-sub --yes
# Factory/noninteractive equivalent:
KYB_MODEL_REACH=claude-sub kyb init acme-atlas --host=exe --yes
```

An explicit `--model-reach` takes precedence over `KYB_MODEL_REACH`. The
`claude-sub` reach is exe-only because its OAuth proxy must run on the same host.
It currently supports the bare Anthropic id `claude-opus-5` only (the gateway
form `anthropic/claude-opus-5` is normalized); other model ids are rejected
because `@kybernesis/exe` certifies its exported context-window constant for that
model only.

The generated root and all generated model-bearing subagents use
`createAnthropic` from `@ai-sdk/anthropic` with `claudeSubscription()` and
`CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW` from `@kybernesis/exe`. This is Eve 0.49's
documented provider-authored AI SDK `LanguageModel` shape (`node_modules/eve/docs/agent-config.md`),
not a gateway string. Subscription scaffolds do not write or read `EXE_MODEL`.
On the host, stand up and authenticate the loopback-only proxy:

```bash
bash scripts/claude-subscription.sh up
bash scripts/claude-subscription.sh login
bash scripts/claude-subscription.sh status
```

The concrete provider and proxy contract is documented in
`packages/exe/src/claude.ts` and `packages/exe/README.md`.

## `kyb doctor`

Run inside an agent project. Checks, with pass/warn/fail per line:

- all four `@kybernesis/*` packages installed
- **every Arcana key↔workspace pair validated read-only against the live API**
  (200 / wrong-key 403 / missing-workspace 404, each with the fix)
- control-plane issuer JWKS reachable; `KYBERNESIS_AGENT` set
- Slack connector UID present
- model reach (`claude-sub`, `exe`, gateway, direct provider, or unresolved)
- `eve info` discovery clean
- port 2000 free (a running dev server makes `eve eval` exit early)

Exit code 1 on any failure — usable as a CI preflight.

## `kyb upgrade [--skip-eval] [--yes]`

Compares installed `@kybernesis/*` versions against npm, installs what's
behind, typechecks, then **runs the eval suite as the gate** — prints
"deploy" only on green. This is the maintenance-retainer loop as a command:
package improvement → `kyb upgrade` per client → green → `npx eve deploy`.

Before an eve version change, upgrade reads `.eve/.workflow-data/runs`, prints
`This will reset N open conversations`, lists matching persisted Buzz channel
sessions when available, and requires explicit confirmation. Noninteractive
runs fail closed unless `--yes` (or `-y`) is supplied. The warning is still printed with
`--yes` and is not bypassed by `--skip-eval`. Existing direct `eve eval` scripts
are migrated to `kyb-eval`; custom scripts are left untouched with a manual fix.
The wrapper counts corruption diagnostics beside the eval result and turns a
nominally green eve exit into a failure when condemned durable state was seen.

On self-hosted agents, upgrade also reconciles package-owned host artifacts. It
refreshes a stale `/etc/cron.daily/kyb-docker-prune` and an existing generated
systemd unit, warning before replacement and printing an exact manual repair
command if non-interactive sudo is unavailable. A missing systemd unit is not
created implicitly, and refreshing an existing unit does not restart the agent.

## Design notes

- **Zero runtime dependencies** — node builtins only (`spawnSync`, `readline`,
  global `fetch`). Nothing to audit, nothing to break.
- The scaffold pins the eve version the packages are developed against;
  upgrading eve is a deliberate, eval-gated step — not something a scaffold
  should do implicitly.
- Human steps stay human: Slack's browser flow, key creation, and admin grants
  can't be automated away — the CLI sequences everything around them and hands
  you the checklist. Don't promise zero-touch.
