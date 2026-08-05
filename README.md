# Kybernesis Platform

The product monorepo for **Kybernesis** — the ecosystem layer that makes
[eve](https://eve.dev) agent deployments enterprise-ready and uniquely
Kybernesis. Eve is the plumbing; this is the moat.

## Packages (all Apache-2.0, published to npm)

| Package | What it gives an agent |
| --- | --- |
| [`@kybernesis/arcana`](./packages/arcana) | Durable long-term memory (Arcana): MCP connection, recall/remember/brain-note skills, recall-first instructions |
| [`@kybernesis/enterprise`](./packages/enterprise) | Control-plane governance: offline token verification + per-agent grant enforcement (invite / grant / revoke / suspend) |
| [`@kybernesis/multiplayer`](./packages/multiplayer) | Shared conversations: per-speaker verified identity, attributed threads, no-re-mention continuation, dual surfaces |
| [`@kybernesis/evals`](./packages/evals) | The baseline QA suite: memory/routing/smoke behaviors with every production hardening lesson as a default |
| [`@kybernesis/create`](./packages/create) | The `kyb` CLI: `init` scaffolds a full governed/remembering/multiplayer/self-testing agent in one command; `doctor` preflights an engagement; `upgrade` bumps packages behind the eval gate |

## Also in this repo

- **[`fixtures/governed-ref`](./fixtures/governed-ref)** — the minimal governed
  eve agent used as the enterprise package's reference consumer and E2E harness
  (proved the invite → grant → access → revoke loop against the production
  control plane).
- **[`registry/`](./registry)** — source of **https://registry.kybernesis.ai**,
  the shadcn-format eve integration registry serving all of the above:

  ```bash
  eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
  eve add @kybernesis/enterprise
  eve add @kybernesis/arcana
  eve add @kybernesis/multiplayer
  eve add @kybernesis/evals
  ```

## Related, not in this repo

- **Control plane** (`kybernesis-admin`, prod: `agent.kybernesis.ai`) — the
  issuer/governance service the enterprise package verifies against.
- **Kyber** (`KybernesisAI/kyber`) — our own production company agent: the
  reference deployment that dogfoods every package here via published versions.
- **Eve Studio** — desktop client for non-Slack access (sign-in via the
  control plane's device flow).

## Development

```bash
npm install
npm run build        # builds every package
npm run typecheck
```

Packages consume `eve` as a wildcard peer; the pinned dev version lives in each
package's `devDependencies`. Publishing: bump the package version, `npm publish
<path> --access public` (requires the `kybernesis` npm account's browser auth),
then update the registry item if install-time files changed.

History note: these packages were originally developed inside the Kyber agent
monorepo (`KybernesisAI/kyber`) and extracted here 2026-08-05; pre-extraction
history lives there and in the retired per-package mirrors
(`arcana-eve`, `enterprise-eve`).
