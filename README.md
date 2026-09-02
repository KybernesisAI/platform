# Kybernesis Platform

The product monorepo for **Kybernesis** — the ecosystem layer that makes
[eve](https://eve.dev) agent deployments enterprise-ready and uniquely
Kybernesis. Eve is the plumbing; this is the moat.

## Packages (all Apache-2.0, published to npm)

| Package | What it gives an agent |
| --- | --- |
| [`@kybernesis/arcana`](./packages/arcana) | Durable Arcana memory through an MCP connection, recall/remember/brain-note skills, per-session workspace selection, and recall-first instructions |
| [`@kybernesis/enterprise`](./packages/enterprise) | Control-plane identity verification and per-agent grant enforcement for governed user and agent-to-agent requests |
| [`@kybernesis/multiplayer`](./packages/multiplayer) | Shared Slack conversations with per-speaker identity, attributed thread context, mentionless continuation, DM resets, and verified DM/channel surface helpers |
| [`@kybernesis/buzz`](./packages/buzz) | Membership in a Buzz workspace as a full participant: per-speaker verified identity through the control plane, self-service identity linking, presence, typing and seen signals, image attachments, session continuity across restarts, and projects/issues/PRs/notes as tools |
| [`@kybernesis/evals`](./packages/evals) | Composable smoke, memory, safety, routing, and optional engineer evaluation suites, plus tool-result helpers |
| [`@kybernesis/engineer`](./packages/engineer) | A vision-verified engineering extension with sandbox screenshot and artifact-delivery tools, build/ship skills, and credential-safe git/branch helpers |
| [`@kybernesis/dispatch`](./packages/dispatch) | Declared remote-agent edges and receiver channels with principal forwarding, pinned trusted peers, and optional control-plane-governed discovery and authentication |
| [`@kybernesis/connectors`](./packages/connectors) | Per-principal SaaS and remote MCP tools resolved through the control plane, including multi-account naming and brokered execution |
| [`@kybernesis/local`](./packages/local) | Shell, file, search, edit, and local MCP tools relayed to the user's machine through KYBER Studio with declared per-effect consent and optional guards |
| [`@kybernesis/manage`](./packages/manage) | Authenticated management routes and routine tools for installing capabilities, storing the agent credential, and creating or removing schedules on writable agent hosts |
| [`@kybernesis/exe`](./packages/exe) | exe.dev self-hosting with LLM integration and ChatGPT/Grok subscription models, host preflight and supervision, optional Slack/Photon bindings, VM sandboxes, and web previews |
| [`@kybernesis/create`](./packages/create) | The `kyb` CLI for configurable agent scaffolding, Arcana setup, diagnostics, skill installation, credentialing, registration, deployment, and eval-gated upgrades |

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

## Reporting bugs

Please include the version you are using and clear steps to reproduce the problem.
