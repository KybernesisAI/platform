# Kybernesis Platform

The product monorepo for **Kybernesis** — the ecosystem layer that makes
[eve](https://eve.dev) agent deployments enterprise-ready and uniquely
Kybernesis. Eve is the plumbing; this is the moat.

## Packages (all Apache-2.0, published to npm)

| Package | What it covers |
| --- | --- |
| [`@kybernesis/arcana`](./packages/arcana) | Per-brain Arcana long-term memory through an MCP connection, with recall, remember, and brain-note skills plus recall-first instructions. |
| [`@kybernesis/connectors`](./packages/connectors) | Per-principal SaaS tools and remote MCP servers dynamically resolved through the Kybernesis control plane. |
| [`@kybernesis/create`](./packages/create) | The `kyb` CLI for scaffolding, diagnosing, configuring, registering, deploying, upgrading, and installing FDE skills for Kybernesis agents. |
| [`@kybernesis/dispatch`](./packages/dispatch) | Declared agent-to-agent remote-peer edges and receiver channels with principal forwarding and constrained trusted peers. |
| [`@kybernesis/engineer`](./packages/engineer) | An eve engineering extension with screenshot-based visual verification, delivery tooling, disciplined git behavior, and build-and-ship skills. |
| [`@kybernesis/enterprise`](./packages/enterprise) | Kybernesis identity and policy token verification with per-agent grant enforcement for governed user and agent-to-agent requests. |
| [`@kybernesis/evals`](./packages/evals) | Composable smoke, memory, safety, routing, and optional engineer evaluation suites. |
| [`@kybernesis/exe`](./packages/exe) | Support for running agents on exe.dev with integration- or subscription-backed models, host preflight, sandbox and preview helpers, and optional Slack and Photon bindings. |
| [`@kybernesis/local`](./packages/local) | Shell, file, search, edit, and local-MCP work relayed to a user's machine through KYBER Studio with per-effect consent and optional guards. |
| [`@kybernesis/manage`](./packages/manage) | Authenticated management routes and routine tools for installing capabilities, storing credentials, and creating or deleting schedules in a writable agent checkout. |
| [`@kybernesis/multiplayer`](./packages/multiplayer) | Shared Slack-thread conversations with per-speaker identity, attributed context, no-re-mention continuation, channel or DM surface marking, and privacy guards. |

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

- **[`docs/`](./docs)** — [`gaps.md`](./docs/gaps.md) is the honest ledger of
  what is verified, what is built-but-never-run, and what is missing. Read it
  before promising anything to a client.

## Related, not in this repo

- **Control plane** ([`KybernesisAI/kybernesis-admin`](https://github.com/KybernesisAI/kybernesis-admin),
  prod: `agent.kybernesis.ai`) — the issuer/governance service the enterprise
  package verifies against, and the broker for connectors and local access.
- **Kyber** ([`KybernesisAI/kyber`](https://github.com/KybernesisAI/kyber)) — our
  own production company agent: the reference deployment that dogfoods every
  package here via published versions.
- **KYBER Studio** ([`KybernesisAI/kyber-studio`](https://github.com/KybernesisAI/kyber-studio))
  — the desktop client. Signed, notarized, self-updating; the consumer of
  `local`, `connectors`, and `manage`.
- **Sid** ([`KybernesisAI/sid`](https://github.com/KybernesisAI/sid)) — the
  off-Vercel reference deployment (exe.dev, iMessage, a Grok subscription). If
  something works there, it works at a client.

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
