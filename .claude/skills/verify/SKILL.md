---
name: verify
description: "How to verify a change to the platform monorepo (@kybernesis packages, kyb CLI, registry) before it merges and after it publishes: build, typecheck, tests, registry check, eve-line check for released packages, then the publish run and the tarball."
---

# Verifying platform

Done means the package works for a consumer that installs it from npm, not only in this workspace.

## 1. Build and checks (all must pass, same as CI)

```bash
npm ci
npm run build
npm run typecheck
npm test
node scripts/check-registry.mjs
```

For a package whose version you bumped, also build on its eve line and check it: `npm install --no-save eve@^<line>` then `node scripts/check-eve-line.mjs`.

## 2. Try it as a consumer

For a changed package, `npm pack -w packages/<name>` and install the tarball into a scratch folder (`npm init -y && npm install <tarball>`), then import its public entry points with plain Node ESM (`node --input-type=module -e "import('@kybernesis/<name>')"`). A missing `.js` extension or exports-map entry shows up here, not in the workspace.

For a registry change, read the generated `registry/r/<item>.json` and confirm every file it embeds is the current source.

## 3. Evidence for the pull request

List each command and its result, and name the consumer that will be gated on its evals before deploy.

## 4. After the merge

Merging a version bump to `master` publishes through `publish.yml`. Open that Actions run and read its summary for the versions that went out, then poll the tarball URL (`https://registry.npmjs.org/@kybernesis/<name>/-/<name>-<version>.tgz`) until it answers 200 before deploying any consumer. For a registry change, compare the live item with master: `curl -s https://registry.kybernesis.ai/r/eve-0.81/<item>.json | shasum`.
