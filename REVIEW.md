# Review rules: platform

The product monorepo: the `@kybernesis/*` packages that make eve agents enterprise-ready, the `kyb` CLI and the registry. They ship to enterprises through npm. A reviewer reads this file and AGENTS.md from `master`, reviews the pull request's exact head commit, and runs `.claude/skills/verify` itself. Findings are Important (blocks the merge), Nit, or Pre-existing. Start the findings comment with the count of each. At most five Nits.

What failure looks like here: a package that installs but breaks on a client's machine, a release that skips or doubles a version, or our own names leaking into enterprise code.

## Always check

- **It does what the brief says,** all of it, and nothing it doesn't.
- **Naming:** no agent of ours and no competitor named anywhere in packages, docs, tests or fixtures (generic roles like `planner`, `field-ops`). Grep the diff for the names of our own agents.
- **Package conventions (AGENTS.md):** relative imports carry `.js`; exports maps include `"./package.json"`; `eve` stays a peerDependency scoped to the line it was built on, exact pin in devDependencies; `files: ["dist","NOTICE"]`; LICENSE and NOTICE present; `repository.url` points at this repo.
- **Extensions vs libraries:** extensions declare no channels, route auth, sandboxes, schedules or evals; workflow tools (`"use workflow"`, `ctx.ask`) live in registry-written files, not packages; nothing in a driver bundle imports Node builtins.
- **Tool matching** by remote-name suffix, never exact qualified names.
- **Versions:** a behaviour change bumps the package version (merging a bump to `master` is the release); a moved peer range alone is never a release (it needs a build on that eve line, `scripts/check-eve-line.mjs`).
- **Daemon contracts:** nothing control-plane-shaped breaks an existing caller.
- **No secrets** in code, fixtures or logs.

## Reliability checklist (check the item when the diff matches the trigger)

| Diff touches | Check |
| --- | --- |
| `packages/*/package.json` | Version bumped once; peer range matches the eve the dist was built with; no new runtime dep in `create` (node builtins only); lockfile matches. |
| `registry/**` | `registry/r/<item>.json`, `registry/r/registry.json` and `registry/index.html` regenerated together; `node scripts/check-registry.mjs` passes. |
| `.github/workflows/publish.yml`, `scripts/release.mjs`, `scripts/prepublish.mjs` | File name and the `npm` environment unchanged (npm trusted publishing binds to both); a dry run lists the versions it would publish. |
| `packages/evals/**`, eval fixtures | The fixture rules in its README hold (in-test nonces, per-run keys, no security vocabulary); nothing "cleaned up". |
| `packages/create/**` | Still zero runtime deps; `EVE_VERSION` matches the certified pin. |
| Anything a consuming agent loads at boot | The PR names the consumer and how it will be gated (its eval suite) before deploy. |

## Not this repo's business

The consuming agents use these packages from npm; pinning and deploying them is a separate pull request in each agent's repo.
