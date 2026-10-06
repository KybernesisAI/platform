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

### computer — the agent's own computer

One persistent Docker desktop per agent — Chrome, a terminal, a durable
`/workspace` — whose screen a person can watch and take over, in KYBER Studio or
over noVNC. The `computer` tool is eve's `computer_use` with every screenshot
attached as an image; `open_browser` is guarded so a site that has a connector
parks for the person's approval unless the agent states why the browser is
right; the instructions carry the rule: connected app, then a tool, then the
agent's browser, then the person's machine. Becomes the agent's root sandbox.
exe.dev hosts only (needs Docker).

```bash
eve add @kybernesis/computer
```

Package: [`@kybernesis/computer`](https://www.npmjs.com/package/@kybernesis/computer) ·
[source](https://github.com/KybernesisAI/platform/tree/master/packages/computer)

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

### notify — the person's phone

An observe-only hook: when the agent parks on a question, or finishes a reply
while the person is away, the control plane pushes to their KYBER Studio for
iOS. The device that started the turn owns its notifications; they never cross.
Writes `agent/extensions/notify.ts`. Needs the `enterprise` item.

```bash
eve add @kybernesis/notify
```

Package: [`@kybernesis/notify`](https://www.npmjs.com/package/@kybernesis/notify)

### payments — a Link wallet, on the owner's behalf

`eve add @kybernesis/payments` (after `computer`). Mounts Stripe's Link tools
(`create_spend_request`, `request_spend_approval`, `retrieve_spend_request`, `create_report`, …)
behind the OWNER's `link-cli` sign-in on the agent's host — one wallet per agent,
the owner approving each purchase in the Link app — plus `pay_on_computer`, which
types the approved one-time card into the checkout open in the agent's browser.
The card number goes Link → page and is never a tool result.

Owner, once, on the host: `npx link-cli auth login --client-name <agent>`.

### vault — the person's passwords and cards, never read by the model

`eve add @kybernesis/vault` (after `computer` and `enterprise`). People save
logins, cards and addresses in KYBER Studio (Settings → Vault); they are sealed in
the control plane. `list_vault` shows an agent what applies to the site it is on
(labels, usernames, brand and last four), `fill_from_vault` types an item into
the page on the agent's own computer. A login only fills on the site it was
saved for; a card asks the person each time; every materialization is audited.

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
