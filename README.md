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
| [`@kybernesis/manage`](./packages/manage) | Authenticated management routes and routine tools for installing capabilities, storing the agent credential, creating or removing schedules, and owner-only setup (model reach, Slack, iMessage line, Link wallet, computer password) on writable agent hosts |
| [`@kybernesis/exe`](./packages/exe) | exe.dev self-hosting with LLM integration and ChatGPT/Grok subscription models, host preflight and supervision, optional Slack, Photon and Linq (iMessage) bindings, VM sandboxes, and web previews |
| [`@kybernesis/computer`](./packages/computer) | A persistent, isolated computer per agent (a Docker desktop with Chrome that a person can watch and take over), a computer tool that returns real screenshots, browser open and tab tools, and the rule for when to use it instead of a connector |
| [`@kybernesis/vault`](./packages/vault) | The person's own logins, cards and addresses, per person and per agent: the agent sees labels only, the control plane holds the secrets, and a fill tool types them into the page on the agent's computer |
| [`@kybernesis/payments`](./packages/payments) | Stripe Link as the agent's wallet on its owner's behalf, with the person's approval on every purchase and a one-time card typed into checkout on the agent's computer |
| [`@kybernesis/identity`](./packages/identity) | The agent's `.agent` identity: verification document, signed push tokens, and paired peers as tools |
| [`@kybernesis/notify`](./packages/notify) | Push notifications to the person's phone when their agent needs them or finishes a turn, through the control plane |
| [`@kybernesis/voice`](./packages/voice) | Realtime voice for KYBER Studio, the phone and the watch: the voice speaks as the agent and hands every real request to the agent's own session |
| [`@kybernesis/create`](./packages/create) | The `kyb` CLI for configurable agent scaffolding, Arcana setup, diagnostics, skill installation, credentialing, registration, deployment, and eval-gated upgrades; `kyb init --host=exe` installs computer and vault by default |

## Also in this repo

- **[`fixtures/`](./fixtures)** — private, never published.
  [`governed-ref`](./fixtures/governed-ref) is the minimal governed eve agent
  used as the enterprise package's reference consumer and E2E harness (proved
  the invite → grant → access → revoke loop against the production control
  plane); `eyes-spike` exercises the Docker workshop sandbox.
- **[`registry/`](./registry)** — source of **https://registry.kybernesis.ai**,
  the shadcn-format eve integration registry serving all of the above. It
  deploys automatically from `master`.

  ```bash
  eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
  eve add @kybernesis/arcana
  eve add @kybernesis/enterprise
  eve add @kybernesis/computer
  eve add @kybernesis/vault
  eve add @kybernesis/evals
  ```

- **[`docs/`](./docs)** — [`HANDOFF.md`](./docs/HANDOFF.md) is the repo map
  and fresh-machine setup; [`gaps.md`](./docs/gaps.md) is the honest ledger of
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
  `local`, `connectors`, `manage`, `vault`, `computer` and `voice`.
- **KYBER Studio Mobile** ([`KybernesisAI/kyber-studio-mobile`](https://github.com/KybernesisAI/kyber-studio-mobile))
  — the same client on iOS and Android (Expo), and the receiver for `notify`.
- **Sid** ([`KybernesisAI/sid`](https://github.com/KybernesisAI/sid)) — the
  off-Vercel reference deployment (exe.dev, iMessage, a Grok subscription). If
  something works there, it works at a client.

## Development

Node 24 is required (eve refuses older Node).

```bash
npm install
npm run build        # builds every package
npm run typecheck
npm test
node scripts/check-registry.mjs
```

Every package is built against one eve line: `eve` is a peer dependency
scoped to that line (`>=0.68.0 <0.69.0`) with the exact certified version
(**0.68.0**, the same as `EVE_VERSION` in `packages/create/src/util.ts`) in
`devDependencies`. Moving to a new eve is a deliberate, eval-gated
certification, not a version bump.

Publishing: bump the package version (`scripts/prepublish.mjs` refuses a
version already on npm), run `node scripts/check-eve-line.mjs`, then publish
with the npm account's browser 2FA. Update the registry item if install-time
files changed and push to `master`. The consuming agent's eval suite gates
every release.

History note: these packages were originally developed inside the Kyber agent
monorepo (`KybernesisAI/kyber`) and extracted here 2026-08-05; pre-extraction
history lives there and in the retired per-package mirrors
(`arcana-eve`, `enterprise-eve`).
