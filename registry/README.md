# Kybernesis eve registry

A [shadcn-format](https://ui.shadcn.com/docs/registry) integration registry for
[eve](https://eve.dev) agents, served at **https://registry.kybernesis.ai**.

## Add the registry (once per project)

```bash
eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
```

## Items

### arcana — durable long-term memory

Arcana MCP connection, recall/remember/brain-note skills, and recall-first
instructions. Mount once per brain.

```bash
eve add @kybernesis/arcana
```

Package: [`@kybernesis/arcana`](https://www.npmjs.com/package/@kybernesis/arcana) ·
[source](https://github.com/KybernesisAI/arcana-eve) ·
[Arcana](https://kybernesis.ai/arcana)

### enterprise — control-plane governance

Offline verification of Kybernesis control-plane identity tokens + policy
bundles, with per-agent grant enforcement (invite / grant / revoke / suspend
from the admin). Writes a governed `agent/channels/eve.ts`.

```bash
eve add @kybernesis/enterprise
```

Package: [`@kybernesis/enterprise`](https://www.npmjs.com/package/@kybernesis/enterprise) ·
[source](https://github.com/KybernesisAI/enterprise-eve)

### multiplayer — shared conversations

Shared Slack threads with per-speaker verified identity, attributed context,
no-re-mention continuation, and dual-surface (channel vs DM) sessions. Writes
`agent/channels/slack.ts` and a multiplayer instructions fragment.

```bash
eve add @kybernesis/multiplayer
```

Package: [`@kybernesis/multiplayer`](https://www.npmjs.com/package/@kybernesis/multiplayer)

### evals — the baseline QA suite

Smoke, memory, and routing eval suites as composable factories, with every
production hardening lesson shipped as a default. Writes
`evals/kybernesis.eval.ts` + `evals/evals.config.ts`.

```bash
eve add @kybernesis/evals
```

Package: [`@kybernesis/evals`](https://www.npmjs.com/package/@kybernesis/evals)

## The full install (a governed, remembering, multiplayer, self-testing agent)

```bash
eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
eve add @kybernesis/enterprise
eve add @kybernesis/arcana
eve add @kybernesis/multiplayer
eve add @kybernesis/evals
```

All packages are Apache-2.0 on npm. Registry payloads live under `r/`; item
source files under `registry/`.
