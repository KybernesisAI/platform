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
[source](https://github.com/KybernesisAI/platform/tree/master/packages/arcana) ·
[Arcana](https://kybernesis.ai/arcana)

### enterprise — control-plane governance

Offline verification of Kybernesis control-plane identity tokens + policy
bundles, with per-agent grant enforcement (invite / grant / revoke / suspend
from the admin). Writes a governed `agent/channels/eve.ts`.

```bash
eve add @kybernesis/enterprise
```

Package: [`@kybernesis/enterprise`](https://www.npmjs.com/package/@kybernesis/enterprise) ·
[source](https://github.com/KybernesisAI/platform/tree/master/packages/enterprise)

### multiplayer — shared conversations

Shared Slack threads with per-speaker verified identity, attributed context,
no-re-mention continuation, and dual-surface (channel vs DM) sessions. Writes
`agent/channels/slack.ts` and a multiplayer instructions fragment.

```bash
eve add @kybernesis/multiplayer
```

Package: [`@kybernesis/multiplayer`](https://www.npmjs.com/package/@kybernesis/multiplayer)

### buzz — the agent as a workspace member

An agent inside a [Buzz](https://buzz.xyz) workspace as a member rather than a
shared service account: each turn runs as the person who sent the message, with
their own memory, connections and access. Unknown senders are sent a sign-in
link privately and linked to their control-plane identity self-service. Presence,
typing and 👀 come with it.

Installs a workspace-behaviour instructions fragment; the bridge itself runs
beside the agent:

```bash
eve add @kybernesis/buzz
npx kybernesis-buzz init     # prints the key to invite to the workspace
npx kybernesis-buzz run
```

Package: [`@kybernesis/buzz`](https://www.npmjs.com/package/@kybernesis/buzz)

### evals — the baseline QA suite

Smoke, memory, and routing eval suites as composable factories, with every
production hardening lesson shipped as a default. Writes
`evals/kybernesis.eval.ts` + `evals/evals.config.ts`.

```bash
eve add @kybernesis/evals
```

Package: [`@kybernesis/evals`](https://www.npmjs.com/package/@kybernesis/evals)

### engineer — the vision-verified dev loop

Workshop sandbox (Playwright in the template), a screenshot tool the model can
see, and build/ship skills. Writes `agent/extensions/engineer.ts` and
`agent/sandbox/sandbox.ts`.

```bash
eve add @kybernesis/engineer
```

Package: [`@kybernesis/engineer`](https://www.npmjs.com/package/@kybernesis/engineer)

## The full install (a governed, remembering, multiplayer, self-testing agent)

```bash
eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
eve add @kybernesis/enterprise
eve add @kybernesis/arcana
eve add @kybernesis/multiplayer
eve add @kybernesis/evals
eve add @kybernesis/engineer   # optional: the engineer layer
```

All packages are Apache-2.0 on npm. Registry payloads live under `r/`; item
source files under `registry/`.
