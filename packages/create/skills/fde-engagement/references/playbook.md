# Kybernesis Forward-Deployment Playbook

**Audience:** a Kybernesis forward-deployed engineer (FDE) running a client pilot
engagement. Assumes you are a competent engineer who has **never seen this stack**.
Everything you need is either in this document or behind a link in it.

**Canonical location:** this Obsidian vault. An older, shorter copy may still exist at
`~/Desktop/kybernesis-engagement-playbook.md` — that one is stale; this is the one.

**Companion docs**
- [[kybernesis-system-overview]] — what the whole system is and why. Read it once
  before your first engagement; you do not need it again during one.
- [[kybernesis-architecture-and-studio-signin]] — the auth contract in full plus the
  Eve Studio sign-in brief.

---

## ⚡ The fast path: `kyb` (read this first, then use the rest as reference)

Everything in §3–§4 of this playbook — scaffold, registry, all four packages,
department subagents, memory mounts, eval wiring — is automated by
**`@kybernesis/create`**, our CLI (`kyb`). The manual sections below remain the
canonical reference for *what the CLI writes and why*, and for fixing anything by
hand; but a normal engagement starts here.

### Starting from zero on the client's computer

You will often be on a machine that has nothing on it. The complete bootstrap, in
order — nothing else is required before the first command:

```bash
# 1. Node.js 24 LTS (the only true prerequisite; installer from nodejs.org, or:)
#    macOS:  brew install node@24        Windows: winget install OpenJS.NodeJS.LTS
node -v    # must be >= 24

# 2. Scaffold the agent — no install step needed; npm fetches the CLI itself:
npm create @kybernesis acme-atlas
# …or, when the client wants an agent that BUILDS software (the engineer layer):
npm create @kybernesis acme-atlas -- --engineer
#    Prompts: display name · department subagents · control-plane issuer.
#    (Non-interactive/CI: defaults apply when stdin is not a terminal.)

# 3. (Optional, for repeated use) put `kyb` on the PATH for the whole engagement:
npm install -g @kybernesis/create
```

That's it: `npm create @kybernesis <name>` downloads and runs the scaffolder in one
step — the npm registry is the distribution channel, so a fresh laptop needs only
Node. The Vercel CLI installs itself the first time an `npx vercel …` command runs
(or `npm i -g vercel` if you prefer it resident).

### What `kyb init` leaves you with

A complete agent directory — governed (`enterprise`), remembering (`arcana`),
multiplayer Slack (`multiplayer`), self-testing (`evals`), with one generated
subagent per department you named (routing description, instructions, its own
Arcana connection, the three memory skills) — already typechecked and
discovery-clean. It ends by printing **the human-steps checklist**, which is
exactly §§2, 5, 6, and 7 of this playbook:

1. Arcana workspaces + scoped `kb_` keys → fill `.env.local` from `.env.example`
2. `vercel link` (the **client's** team) + envs (prod/preview Sensitive)
3. The Slack connector browser flow (§5.1)
4. Control-plane registration (▲ eve) + pilot-cohort grants (§6)
5. `npm run eval` → green → `npx eve deploy` → Slack smoke + the revoke demo (§7)

### The `kyb` command reference

| Command | When | What it does |
| --- | --- | --- |
| `npm create @kybernesis <name>` | Day 1, once | Same as `kyb init <name>` without installing anything first |
| `kyb init <name>` | Day 1, once | eve scaffold (pinned version) + registry + all four packages + generated departments + eval wiring + env template + checklist |
| `kyb init <name> --engineer` | When the pilot includes building software | Everything above PLUS the engineer layer: workshop sandbox (Playwright baked into the template), the vision screenshot tool, build/ship skills, and the official limbs (agent-browser, github-tools, vercel connection) |
| `kyb doctor` | **Constantly** — after every human step, before every deploy, whenever anything is weird | Live preflight: every Arcana key↔workspace pair validated against the API (with the specific fix per failure: wrong-key 403 vs missing-workspace 404), issuer JWKS reachability, `KYBERNESIS_AGENT`, Slack connector env, `eve info` discovery, port-2000 conflict. Exit 1 on failure → usable in CI |
| `kyb upgrade` | Maintenance visits / after Kybernesis ships a package update | Compares installed `@kybernesis/*` against npm **and eve against the Kybernesis-certified version** (never blindly npm-latest — we certify eve releases in the platform repo first), installs what's behind, typechecks (+ `eve info` after a framework bump), then **runs the eval suite as the gate** — tells you to deploy only on green |
| `kyb upgrade --skip-eval` | Never for production changes | Same, without the gate |

**Habit to build:** `kyb doctor` is the debugging you would otherwise do by hand
with curl — run it before asking why something doesn't work. Green doctor + green
`npm run eval` = safe to deploy.

---

## 0. What you are actually doing

You walk into a client company for roughly a week and leave behind:

1. **A company agent** — an [eve](https://eve.dev) agent, running on **the client's own
   Vercel team**, answering in **the client's own Slack workspace**.
2. **Department subagents** — finance, engineering, marketing, support, whatever their
   org chart says — each with its own long-term memory and its own tools.
3. **Governance** — the client's admin can invite an employee, grant them the agent,
   and revoke it, from a web UI, with revocation taking effect inside the token TTL.
4. **An eval suite** — the QA deliverable. It is how you and the client both know the
   agent still works after a change.

The commercial shape of this matters to how you build it. Our pitch is **"your source →
your runtime → your data → your token."** Everything above lives in *the client's*
accounts. Kybernesis operates exactly one thing on the client's behalf — the **control
plane** at `https://agent.kybernesis.ai` — and maintains the npm packages that make the
rest possible. Do not create client resources inside Kybernesis accounts. If you catch
yourself doing so, stop and fix it before it becomes the handover conversation.

### Placeholders used throughout

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `ACME` | the client company / control-plane org | Northwind |
| `acme` | the client slug, lowercase | `northwind` |
| `atlas` | the agent's name — whatever the client wants | `nora` |
| `acme-atlas` | the repo / Vercel project name | `northwind-nora` |
| `<dept>` | a department subagent | `finance` |
| `slack/atlas` | the Vercel Connect connector UID | `slack/nora` |

The agent's name is client-chosen and appears in three places that **must agree**: the
`KYBERNESIS_AGENT` env var, the agent's registered name in the control plane, and the
Slack app's display name (the last one is cosmetic but confusing if it differs).

### Timeline for a standard pilot

| Day | Work |
| --- | --- |
| Day 0 (remote) | Phase 1 pre-engagement checklist |
| Day 1 morning | Phase 2 discovery conversation |
| Day 1 afternoon | Phase 3 environment setup, agent scaffolded and running locally |
| Day 2–3 | Phase 4 build: instructions, subagents, memory, evals |
| Day 3 | Phase 5 deploy + Phase 6 control-plane wiring |
| Day 4 | Phase 7 pilot onboarding — the humans |
| Day 5 | Phase 8 acceptance demo, Phase 9 handover |

Pull days 2–3 longer if they have real proprietary systems to integrate; that work is a
custom eve extension and is the billable heart of the engagement.

---

## 1. Pre-engagement checklist (do this remotely, ~1 hour, before you travel)

Nothing here needs the client in the room, but several items need them to have clicked
something. Chase them a week out — an unprovisioned Vercel team on Day 1 costs you a day.

- [ ] **Client has a Vercel team.** Any plan tier works for a pilot; Pro if they want
      preview protection off the shelf. You need a member seat on it, or a named client
      engineer who can run `vercel` commands next to you.
- [ ] **You have `node 24.x`, `npm`, and the Vercel CLI** on the machine you will build
      on. Verify:
      ```bash
      node -v          # expect v24.x
      npm -v
      npm install -g vercel@latest
      vercel whoami
      ```
- [ ] **You can log in to the control plane** at <https://agent.kybernesis.ai> and you
      have permission to create an org there. If ACME is self-hosting the control plane
      instead, confirm their issuer URL now — it changes `KYBERNESIS_ISSUER` everywhere.
- [ ] **Create the control-plane org for ACME** and invite yourself as an admin of it.
      Do not build inside the Kybernesis org.
- [ ] **Provision Arcana workspaces** — one per brain. The naming convention is
      `acme-company` for the shared root brain, `acme-<dept>` per subagent, and
      `acme-eval` for hermetic eval runs. Create each at
      <https://arcana.kybernesis.ai> and mint a **workspace-scoped `kb_` key** for each.
- [ ] **Validate every key before you leave.** Keys are workspace-scoped: a key for one
      workspace returns `403` on any other, and finding that out during a live demo is
      avoidable. Read-only check, one per workspace:
      ```bash
      curl -s -o /dev/null -w "HTTP %{http_code}\n" \
        -H "Authorization: Bearer kb_REPLACE_ME" \
        -H "X-Kyberagent-Agent: acme-company" \
        "https://api.arcana.kybernesis.ai/brain/acme-company/timeline?limit=1"
      # expect HTTP 200
      ```
- [ ] **Confirm who at ACME is the Slack workspace admin.** Creating the Slack connector
      requires someone who can approve a Slack app install. If that person is on holiday
      your Day 2 is Slack-less.
- [ ] **Read the reference implementation.** `~/kyber` is our own production agent and
      the canonical example of everything in Phase 4. Skim `agent/agent.ts`,
      `agent/instructions/`, `agent/subagents/finance/`, and `evals/`.
- [ ] **Confirm package versions you will pin.** As of 2026-08-06:
      `@kybernesis/arcana@0.1.1`, `@kybernesis/enterprise@0.1.2`,
      `@kybernesis/multiplayer@0.1.0`, `@kybernesis/evals@0.2.1`,
      `@kybernesis/create@0.1.4`, `@kybernesis/engineer@0.2.0`, and
      `eve@0.30.8` (the Kybernesis-certified version). All public on npm;
      `kyb doctor` checks the wiring.

---

## 2. The discovery conversation (Day 1 morning, 90 minutes, with the client)

This is a working session, not a requirements-gathering ritual. Your goal is to leave the
room able to run Phase 3 without asking anyone anything. Bring a laptop and fill in the
table below live.

### 2.1 The agent itself

- **"What is it called?"** They pick. It appears in Slack, so it should be something
  people will actually type. Write it down as `atlas`.
- **"What is its voice?"** Terse and factual, or warm? This becomes
  `agent/instructions/identity.md`. Ask for two or three examples of a good answer and a
  bad answer — those examples become evals.
- **"What should it refuse to do?"** Anything they name here becomes an instruction and,
  if it matters, a hard guard in code rather than a prompt.

### 2.2 Departments

- **"Which departments would ask this thing questions?"** Aim for three to five
  subagents in a pilot. More is a scoping conversation, not a build.
- For each: **what does it know that nobody else does**, and **what systems does it need
  to read?** The first answer sizes its memory workspace; the second is either an
  off-the-shelf eve connection or a custom extension you will write.
- Watch for a department that is really a *separate agent* (in our own setup, GTM was —
  it already had its own agent). Splitting is cheaper than untangling later.

### 2.3 Surfaces — don't assume Slack

- **"Where do you actually talk?"** eve ships channels for Slack, iMessage
  (Photon), Telegram, Discord, Teams, SMS/phone (Twilio), GitHub, Linear, and
  a web chat — the agent can live on several at once (§4.3c has the table and
  install commands). Slack gets the richest treatment (our multiplayer group
  semantics); the rest are 1:1 surfaces today. Pick with the client, then ask
  the Slack questions below only if Slack made the list.

### 2.3a Slack specifics

- **Workspace name and admin contact.**
- **Which channels does the agent join?** For a pilot, one shared channel is usually
  right. Ask explicitly whether they want it in a channel with sensitive content.
- **Do they want thread-following?** (People keep talking to the agent in a thread
  without re-mentioning it.) This is the default in our multiplayer package and it is
  what makes the agent feel like a colleague, but it needs extra Slack scopes —
  `message.channels` + `channels:history`, and the `groups` pair for private channels.
  Get scope approval in the same conversation as the app install.
- **Do they want DMs?** DMs are a per-person surface with a separate memory workspace.
  Almost everyone says yes.

### 2.4 The pilot cohort

- **"Name the five to ten people who will use this in week one."** Get names, emails, and
  Slack handles into a table. You will invite exactly these people in Phase 7.
- **Who is the client-side admin?** They get the `manage` grant level and they are the
  person you train on invite/grant/revoke. Ideally two people, so a holiday does not
  block off-boarding.
- **Who is the internal champion** who will answer "what do I even ask it?" for the
  cohort after you leave?

### 2.5 Data sensitivities — ask these out loud, take notes, put the answers in the doc

- **What must never enter the agent's memory?** Credentials, obviously. But also: salary
  data, customer PII, unannounced M&A, health information. The memory instructions carry
  a no-secrets rule, but a rule in a prompt is not a control — if something must not be
  stored, do not connect the system it lives in.
- **Which department brains must not read each other?** Each subagent gets its own
  Arcana workspace with its own scoped key, so this is free — but you need to know the
  boundaries to name the workspaces correctly.
- **Is the shared channel brain readable by everyone in the workspace?** Today, yes:
  anyone in the Slack workspace who can see the bot can talk to it, and public-channel
  memory is shared. Say this plainly. If they need per-person gating on the Slack door,
  that is a known gap (§11) and you should scope the pilot around it.
- **Where does their data physically live and does that matter?** Agent runtime and
  session data: their Vercel account. Long-term memory: Arcana, our SaaS. Identity and
  grants: the control plane. Model traffic: the AI Gateway provider their eve project is
  configured for. If any of those three placements is a problem, surface it now — the
  control plane is self-hostable and that is a different (and larger) engagement.

### 2.6 Leave the room with this table filled in

| Field | Value |
| --- | --- |
| Agent name (`atlas`) | |
| Repo / Vercel project name | |
| Vercel team | |
| Slack workspace + admin | |
| Slack channels | |
| Thread-following? DMs? | |
| Departments (`<dept>` list) | |
| Arcana workspaces + keys | |
| Control-plane org | |
| Pilot cohort (name / email / Slack id) | |
| Client-side admins (`manage` grant) | |
| Never-store list | |
| Custom systems to integrate | |

---

## 3. Environment setup (Day 1 afternoon, ~45 minutes)

> ⚡ **Automated by `kyb init`** (see the fast path at the top). Read this section to
> understand what the CLI wrote, or to do it by hand.

Everything below runs from a working directory of your choosing. Use an absolute path
you will remember; this playbook writes `~/work/acme-atlas`.

### 3.1 Scaffold the agent

```bash
mkdir -p ~/work && cd ~/work
npx eve@latest init acme-atlas
cd ~/work/acme-atlas
```

`eve init` creates the project, installs dependencies, and initializes git. You now have
an `agent/` directory. Confirm eve sees it:

```bash
npx eve info
```

`eve info` prints the resolved application — every tool, skill, subagent, schedule,
channel, and route eve discovered, plus discovery diagnostics. **Run this whenever
something behaves unexpectedly.** It is much faster than booting the dev server and it
answers the single most common question ("did eve even find my file?").

### 3.2 Link it to the client's Vercel team

```bash
cd ~/work/acme-atlas
npx eve link
```

Pick **the client's team**, then create a project named `acme-atlas`. This also pulls an
AI Gateway credential (`VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`) into `.env.local`, so
the agent can call a model.

In CI or any non-interactive context, `eve link` will not work — use
`vercel link --project acme-atlas --yes --non-interactive` instead. If your active Vercel
scope is not the client's team, every subsequent `vercel` call needs
`--scope <client-team-slug>`.

### 3.3 Register the Kybernesis registry

```bash
cd ~/work/acme-atlas
npx eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
```

Type `{name}` literally — it is a placeholder eve substitutes per item. This writes the
mapping into `package.json#registries`. Confirm:

```bash
npx eve registry list --registry @kybernesis
npx eve registry view @kybernesis/arcana
```

### 3.4 Pin your versions

Before you install anything else, decide and record the versions this engagement pins.
Put them in the repo README. Pin `eve@0.30.8` — the **Kybernesis-certified** version
(certification run 2026-08-06: full suite green, zero code changes). Never pin blind
npm-latest; `kyb upgrade` carries a client to the certified pin behind their own eval
gate, and that upgrade is a **deliberate, eval-gated step**, never something that
happens by accident mid-pilot.

---

## 4. Build (Days 2–3)

> ⚡ **The package installs and department scaffolds here are automated by `kyb init`.**
> What remains genuinely manual in this section: tailoring instructions to the client's
> voice, client-specific tools/connections, and any custom extension work.

Build in this order — model, channel, memory, instructions, subagents, schedules,
evals. Each step is testable on its own, and the order avoids the one real trap
(installing the governance package *after* hand-authoring the file it overwrites).

### 4.0 Do the whole phase WITH Claude Code — this is the method, not a tip

Open Claude Code in the agent repo and keep it open for all of Phase 4. The
scaffold already carries the **FDE skill suite** in `.claude/skills/` (seeded
by `kyb init`; refresh with `kyb skills`) — Claude loads the engagement flow,
eve recipes, package gotchas, control-plane wiring, and eval discipline on
demand, so it knows what Kybernesis is doing before you say a word. The
scaffold's `AGENTS.md` additionally points it at the installed eve docs
(`node_modules/eve/docs/` — the source of truth for the pinned version), so it
authors against the real framework instead of guessing. The working rhythm:

1. **Tell it what you're building, paste the discovery table (§2.6).** "This
   agent is called Atlas, lives on Slack + Telegram, needs read access to
   their Postgres and their internal wiki, three departments."
2. **Make it read before it writes.** For anything eve-specific: "read
   `node_modules/eve/docs/channels/telegram.mdx`, then wire the channel."
   Every channel, connection type, and config surface has a doc page; the
   pattern `read the doc → write the file → npx eve info → test in eve dev`
   is the whole game.
3. **You review diffs and run the credential steps** (anything with a browser
   login or a client secret is yours); Claude writes files, runs `eve
   registry` searches, and iterates on eval failures.
4. **Never accept a claim without the check**: `npm run typecheck`, `npx eve
   info` (0 diagnostics), a turn in `eve dev` (§4.4b), evals green (§4.8).

The eve CLI you'll both be living in:

| Command | What it does |
| --- | --- |
| `npx eve dev` | boots the local runtime + opens the chat TUI (test turns here) |
| `npx eve info` | compile + discovery truth: agents, tools, skills, diagnostics |
| `npx eve registry list` / `search <term>` / `view <item>` | discover integrations before writing one |
| `npx eve add <item>` | install a registry item (files + deps; may offer an interactive setup flow — rerun later with `--skip-install`) |
| `npm run eval` | the hermetic suite (§4.8) — kill the dev server first |
| `npx eve build` | production build locally (what the Vercel deploy runs) |
| `vercel deploy --prod --yes` | ship it (§5) |

### 4.0b Pick and pin the model

The model is agent config, not an env var: `agent/agent.ts` calls
`defineAgent`. With **no** `agent.ts`, eve defaults to
`anthropic/claude-sonnet-5`; the moment the file exists, `model` is required —
so pin it deliberately and record it in the repo README with the §3.4 pins:

```ts
// agent/agent.ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
});
```

What to know when choosing:

- The string form is a **Vercel AI Gateway id** (`provider/model` with a dot
  version — `anthropic/claude-opus-4.8`) — routed, no provider key handling.
  This is the default choice for client deploys.
- Direct provider wiring exists when a client requires it (their own
  Anthropic account, data-processing terms): `npm install @ai-sdk/anthropic`,
  then `model: anthropic("claude-opus-4-8")` (note the provider's hyphenated
  id format) with the provider API key in env.
- **Dynamic selection** is supported (`defineDynamic` with a `fallback` and a
  `session.started` handler — e.g. a bigger model for an enterprise-plan
  principal). Prefer `session.started` over per-turn switching: prompt caches
  are per model, and every switch re-ingests the conversation at uncached
  prices. Resolver failures degrade to the fallback, never fail the turn.
- Kyber runs `anthropic/claude-opus-4.8` via the gateway; our eval judges are
  configured separately in `evals/evals.config.ts` and must **never** be the
  model under test.

### 4.1 Install `@kybernesis/enterprise` (governance) — do this FIRST

```bash
cd ~/work/acme-atlas
npx eve add @kybernesis/enterprise
```

This installs the npm package and **writes `agent/channels/eve.ts`, replacing the
scaffold's version.** That is why it goes first: if you hand-edit `agent/channels/eve.ts`
and then run this, your edits are gone.

The file it writes:

```ts
// agent/channels/eve.ts
import { eveChannel } from "eve/channels/eve";
import { kybernesisAuth } from "@kybernesis/enterprise";

export default eveChannel({
  auth: [
    kybernesisAuth({
      issuer: process.env.KYBERNESIS_ISSUER!,
      agent: process.env.KYBERNESIS_AGENT!,
    }),
  ],
});
```

What this does: every request to the agent's HTTP surface (`/eve/v1/*`) must carry a
Kybernesis identity token **and** a policy bundle. The package verifies both **offline**
against the control plane's JWKS, cross-checks that the bundle belongs to the token's
user and org, and then requires the bundle's `agentGrants` to contain *this agent's*
registered name.

- no credentials, or invalid, or expired → **401**
- valid credentials but no grant for this agent → **403 `agent_not_granted`**

Note what is *not* in that auth array: the eve scaffold ships `localDev()` and
`placeholderAuth()`. The governed file drops both. That is intentional — it fails closed
— but it means the `eve dev` TUI cannot reach the HTTP door of a governed agent without
credentials. You will still drive the agent locally through the TUI's own session; you
just cannot `curl` it without a real token.

### 4.2 Install `@kybernesis/arcana` (memory)

```bash
cd ~/work/acme-atlas
npx eve add @kybernesis/arcana
```

This installs the package and writes `agent/extensions/arcana.ts`. **The filename is the
mount namespace** — leave it as `arcana.ts` unless you have a reason not to, because
tool names derive from it.

Edit it to use the client's workspace naming and, if they want the DM/channel memory
split, a `resolveWorkspace` override:

```ts
// agent/extensions/arcana.ts
import arcana from "@kybernesis/arcana";

export default arcana({
  apiKey: process.env.ARCANA_API_KEY!,
  workspace: process.env.ARCANA_COMPANY_WORKSPACE ?? "acme-company",

  // Public channels use the shared company brain; DMs use a personal workspace.
  // `surface` is a VERIFIED principal attribute stamped by the multiplayer Slack
  // channel — never anything the model can influence.
  resolveWorkspace: (ctx) =>
    ctx.session.auth.current?.attributes.surface === "dm"
      ? (process.env.ARCANA_DM_WORKSPACE ?? "acme-dm")
      : undefined,
});
```

What you get from the mount: an MCP connection to `https://mcp.arcana.kybernesis.ai/mcp`
(with the required `X-Kyberagent-Agent: <workspace>` header), three skills
(`recall`, `remember`, `brain-note`), and always-on memory instructions — recall-first
lookups, never claim ignorance without searching, proactive fact storage, no secrets in
memory. Those instruction rules are not decoration; each of them exists because an eval
caught the agent doing the opposite.

### 4.3 Install `@kybernesis/multiplayer` (Slack)

```bash
cd ~/work/acme-atlas
npx eve add @kybernesis/multiplayer
```

This writes `agent/channels/slack.ts` and `agent/instructions/multiplayer.md`, and
declares the `SLACK_CONNECTOR_UID` env var.

> **Status as of 2026-08-05:** the registry item is **live** (`eve add` resolves and
> writes both files), and the package is dogfooded in `~/kyber` — but
> `@kybernesis/multiplayer@0.1.0` is **not yet published to npm**, so the dependency
> install step will fail until it is. Check first:
> ```bash
> npm view @kybernesis/multiplayer version   # E404 means the publish hasn't landed
> ```
> If it 404s, install from the workspace checkout at `~/kyber/packages/multiplayer` (or
> vendor the two files by hand — they are shown below and in
> `agent/instructions/multiplayer.md`) and revisit once the publish lands.

The whole Slack integration is one file:

```ts
// agent/channels/slack.ts
import { connectSlackCredentials } from "@vercel/connect/eve";
import { multiplayerSlackChannel } from "@kybernesis/multiplayer/slack";

export default multiplayerSlackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR_UID!),
});
```

Defaults give you the full multiplayer behavior. What that means concretely:

- **A thread is one shared session with many verified speakers.** Every message
  re-authenticates: `auth.current` is *that message's* verified sender; `auth.initiator`
  stays pinned to whoever started the thread.
- **Attributed thread context.** Messages between agent replies are injected with stable
  per-speaker Slack ids, so the model reads a real multi-party transcript.
- **No re-mentions needed.** Once the agent is active in a thread, anyone can keep
  talking to it.
- **Dual surface.** Channel sessions carry a verified `surface: "channel"` principal
  attribute; DMs carry `surface: "dm"`. Gate tools on it.
- **`/new` in a DM** retires the session and starts fresh.

Options, if the client asked for something different:

| Option | Default | Change it when |
| --- | --- | --- |
| `continuation` | `"subscribed-threads"` | Set `"mention-only"` if they did not approve the history scopes, or find thread-following too chatty |
| `dmReset` | `"/new"` | They want a different command, or `false` to disable |
| `threadContext` | `"incremental"` | `"full"` for whole-thread-every-mention; `false` for triggering message only (no history scope needed) |
| `events` | — | Passed through to the underlying eve Slack channel for custom handlers |

Use the surface helpers to gate anything personal. This is the pattern for every
"only in a DM" capability:

```ts
import { defineTool } from "eve/tools";
import { requireDm } from "@kybernesis/multiplayer";
import { z } from "zod";

export default defineTool({
  description: "Read the caller's personal task list.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    requireDm(ctx.session); // throws a model-visible refusal on the channel surface
    // ...
  },
});
```

`requireDm` **fails closed** and the thrown message is visible to the model, so the agent
relays "DM me for that" naturally. `sessionSurface(ctx.session)` returns
`"channel" | "dm" | null` if you want to branch rather than refuse; the `eve dev` local
principal counts as `"dm"` so you can exercise personal capabilities locally.

**Enforce surface rules in code, never in the prompt.** A prompt is a suggestion; a
throwing guard is a control.

### 4.3b Install `@kybernesis/engineer` (optional — when the agent should BUILD software)

```bash
cd ~/work/acme-atlas
npx eve add @kybernesis/engineer
```

Writes TWO files: `agent/extensions/engineer.ts` (the mount: screenshot tool +
six build/ship skills + engineering-conduct instructions) and
`agent/sandbox/sandbox.ts` (the **workshop**: Playwright + Chromium baked into
the sandbox template, domain allowlist on deployed sessions). Pair it with the
official limbs if not using `kyb init --engineer`:
`npx eve add extension/agent-browser extension/github-tools connection/vercel`
(run individually).

**Wire the Vercel connection** (preview deploys + a clickable link for every
build — proven live 2026-08-06). After `vercel link` in the agent dir:

```bash
vercel connect create mcp.vercel.com --name vercel
vercel connect attach mcp.vercel.com/vercel --yes
```

Then make `agent/connections/vercel.ts` use the **UID, not the short name**:
`connect("mcp.vercel.com/vercel")`. The auth is user-scoped: the FIRST Vercel
tool call posts a "Connect with…" OAuth link in the Slack thread, the turn
parks, and it resumes after the click. Grant **All projects** (the agent
creates new projects on deploy; a fixed project list can't cover them). To
**narrow the grant later** there is no dashboard or CLI grant editor, and
`revoke-tokens` does not kill provider-side tokens — the working recipe is
`vercel connect detach` + `remove` + `create` (same UID) + `attach`: the
authorization dies with the connector. Then trigger the re-auth from a
**fresh session/thread** (existing sessions hold stale auth state and error
without re-prompting) and select only the project(s) that now exist.

> **Scoping — the client story:** the natural boundary is the CLIENT'S
> VERCEL TEAM. The agent, connector, and OAuth grant all live in the
> client's team, so "All projects" means all of *that client's* projects —
> usually exactly right, and it also covers the new projects the agent
> creates on deploy. What we verified live: an All-projects grant really
> does reach every team project (the agent will happily enumerate them),
> and there is no post-hoc grant editor — changing scope means the
> connector reset above. If a client wants a boundary *tighter than their
> team* (e.g. agent may touch only its own projects), do not promise the
> consent picker — enforce it on our side with a policy wrapper on the
> connection (allowlist of project names/IDs checked against tool
> arguments). That wrapper is the auditable answer in a security review. The deploy tool
takes an **inline file tree**, so the agent ships straight from its sandbox —
no git remote and no token ever inside the VM. Previews sit behind Vercel
Authentication by default; the agent posts a `?_vercel_share=` bypass link
(~24 h) and must ASK before changing protection settings.

**Wire file delivery** (the `deliver` tool — documents, exports, artifacts
the client can open in a browser or download):

```bash
vercel blob create-store acme-atlas-deliverables --access public --yes
```

One command: creates the store, links the project, injects
`BLOB_READ_WRITE_TOKEN`. Without it the tool fails with instructions rather
than silently degrading to a memory note.

Know before demoing:

- **The sandbox template bakes at DEPLOY time** (Playwright + Chromium) — a
  broken bootstrap fails the Vercel build loudly instead of surfacing mid-demo.
  Deploys that rebuild the template take minutes; unchanged templates are
  cached and fast.
- **The allowlist is the client's security posture** — deployed sessions can
  only reach the domains listed in `agent/sandbox/sandbox.ts`. A blocked host
  fails loudly; extend the list deliberately, and treat every addition as a
  security decision to note in the handover. The template ships the proven v5
  egress set: Ubuntu mirrors (the base image is Ubuntu), https-rewritten apt,
  and `storage.googleapis.com` (Chromium's CDN).
- **Production promotion is human-approved by design** (the ship skill).
  Never soften this for demo convenience — the approval moment IS the demo.
- The agent's projects live in `/workspace` and persist across sessions and
  redeploys — a build started Tuesday continues Thursday.
- **Coach the agent in prose, not shell.** Slack messages containing raw
  shell syntax can be eaten by Cloudflare's WAF before they reach the agent.

### 4.3c Channels — put the agent on every surface the client uses

Everything above wires *our* layer. This step and the two after it are where
the agent becomes **the client's agent**. All of it assumes zero prior eve
knowledge; every claim here is expandable by reading the named doc page in
`node_modules/eve/docs/` — which is exactly what you tell Claude Code to do.

A channel is one file under `agent/channels/`; the filename is the channel id.
eve normalizes every surface into the same runtime — instructions, tools, and
memory don't change per channel, so adding a second surface never means
re-teaching the agent. What ships:

| The client wants… | Channel | Get it |
| --- | --- | --- |
| Slack (mentions, DMs, threads, buttons) | Slack | our `@kybernesis/multiplayer` (§4.3) — group semantics, dual surface |
| **iMessage** | Photon | `eve add channel/photon-imessage` |
| Telegram bot | Telegram | `eve add channel/telegram` (worked example below) |
| Discord (slash commands, components) | Discord | `eve add channel/discord` |
| Microsoft Teams (+ Adaptive Cards) | Teams | `eve add channel/teams` |
| SMS / phone (speech-transcribed) | Twilio | `eve add channel/twilio` |
| GitHub @mentions, PR review | GitHub | `eve add channel/github` |
| Linear issue delegation | Linear | `eve add channel/linear-agent` |
| Web app / browser chat | eve HTTP + `useEveAgent` | built-in (route auth via enterprise) |

Every channel's doc page (`node_modules/eve/docs/channels/<name>.mdx`) carries
its **complete** setup: the file to write, the env vars, the webhook/app
registration on the provider side, HITL behavior, and auth verification. The
flow is always the same three steps — worked example, Telegram:

**1. The channel file** (`eve add channel/telegram` writes it, or author it):

```ts
// agent/channels/telegram.ts
import { telegramChannel } from "eve/channels/telegram";

export default telegramChannel({
  botUsername: "acme_atlas_bot",
});
```

**2. The provider-side credentials** (this part is always yours, not Claude's):
create the bot with @BotFather, then set both envs (local `.env.local` AND
Vercel, Sensitive):

```bash
TELEGRAM_BOT_TOKEN=123456:...        # from BotFather
TELEGRAM_WEBHOOK_SECRET_TOKEN=...    # any secret you generate
```

**3. Point the provider at the deployed agent.** Each channel mounts a route
(`POST /eve/v1/telegram` here); Telegram needs the webhook registered by hand:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<deployed-app>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

That pattern — file, credentials, point-the-provider-at-the-route — is every
channel. Slack's version is the connector create/attach in §4.3; Discord/Teams
have their own app-portal steps in their doc pages. Good group behavior to
know: Telegram groups only wake the bot on a command, an @mention, or a reply
to the bot; HITL renders as inline-keyboard buttons; replies over 4096 chars
split automatically.

Two honest caveats to state to the client: **multiplayer's group semantics
(shared threads, speaker attribution, no-re-mention) are Slack-only today** —
other surfaces are stock channels, excellent for 1:1; and each surface has its
own provider terms and data flow — sensitive-data review (§2.5) is per
channel, not per agent.

### 4.3d Connections — wire the client's actual systems

A connection turns an external system into tools the model can call. Rule one:
**search before you write** — most requests already exist as registry items:

```bash
npx eve registry list                     # official catalog + our @kybernesis source
npx eve registry search postgres          # capability search (also searches skills.sh)
npx eve registry view connection/linear   # ALWAYS inspect before installing
npx eve add linear                        # multi-part items let you pick components
```

`eve add` installs dependencies and writes the connection file; official items
may then offer an **interactive setup flow** (accounts, OAuth clients) — run
it, or resume a skipped one later with `eve add <item> --skip-install`.

When the registry has nothing (a client's internal service), you write one
file. Two shapes, pick by what the service exposes:

- **MCP server** → `defineMcpClientConnection` (the server publishes tools).
- **OpenAPI 3.x document** → `defineOpenAPIConnection` (each operation
  becomes a tool; filter the operations you actually want).

And four auth modes, pick by who the agent acts as:

| Mode | When | Shape |
| --- | --- | --- |
| **Static token** | org service accounts, internal systems — the pilot default | `auth: { getToken: async () => ({ token: process.env.X_TOKEN! }) }` |
| **Vercel Connect, user-scoped** | the agent acts as *the person* (their Linear, their calendar) | `auth: connect("<connector-uid>")` — first use posts an OAuth link in-thread, turn parks + resumes (§4.3b showed this live) |
| **Vercel Connect, app-scoped** | the agent acts as *itself* against an OAuth service | `connect({ connector: "<uid>", principalType: "app" })` — non-interactive |
| **None** | public/read-only APIs | omit `auth` |

The full static-token example (an internal MCP service):

```ts
// agent/connections/wiki.ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://wiki.internal.acme.com/mcp",
  description:
    "Acme's internal wiki: search pages, read content, list owners.",
  auth: {
    getToken: async () => {
      const token = process.env.ACME_WIKI_TOKEN;
      if (!token) throw new Error("ACME_WIKI_TOKEN is not set.");
      return { token };
    },
  },
});
```

Decide three things per connection, at install time, and write them down:

1. **Auth scope** (table above). Subagents have **no user principal** — inside
   them only static-token or app-scoped Connect works.
2. **Surface gating.** Personal tools get `requireDm`-style fail-closed checks
   (§4.4's surface rules only exist if connections enforce them).
3. **Approval.** Destructive or spend-shaped tools get an `approval` gate —
   per-connection HITL, rendered as buttons on Slack/Telegram.

The `description` matters more than it looks: it's how the model decides to
reach for the connection at all. Write it like a capability, name the systems.

### 4.3e Skills — teach the client's procedures (and mine skills.sh)

A skill is a markdown procedure the model loads **on demand** (eve advertises
each skill's description; the model calls `load_skill` when a turn matches).
Anything the client's team does "the same way every time" — their release
checklist, escalation path, report format — is a skill, not an always-on
instruction. Keep always-on for identity and rules; skills for procedures.

Three authoring forms, in order of reach:

```md
<!-- 1. Flat file: agent/skills/escalation.md — smallest possible skill.
     First body line doubles as the routing description. -->
Use when an incident needs escalation: who to page, in what order, and what
the first Slack message must contain.
...procedure...
```

```md
<!-- 2. Packaged: agent/skills/weekly-report/SKILL.md + references/ dir.
     description frontmatter is REQUIRED here. -->
---
description: Use when someone asks for the weekly ops report.
---
Pull the numbers in this order... (see references/template.md)
```

TypeScript (`defineSkill` from `eve/skills`) is the third form, only for
generated content or typed sibling files — start with markdown.

The rules that make skills actually fire:

- The `description` is a **routing hint, not a label** — write it as the
  triggering task ("Use when…"), and test it in `eve dev` by asking the
  question *without naming the skill* (§4.4b).
- Skills are **scoped per agent** — subagents can't see the root's skills;
  copy what each needs (or use the subagent-local extension mounts that ship
  them, §4.5).
- Loading a skill adds instructions, never tools — typed behavior is a tool.

**skills.sh** — the community skills marketplace — is built into eve's search
as the `@skills` source:

```bash
npx eve registry search "react best practices"     # hits skills.sh too
npx eve add @skills/vercel-labs/agent-skills/vercel-react-best-practices
```

Community skills are third-party project files: **read the source and the
diff before running the agent**, same as any dependency. For client work,
prefer authoring the client's own procedures; pull from skills.sh for generic
craft (framework best practices, review checklists) after review.

### 4.3f Install `@kybernesis/dispatch` (optional — when the client runs MORE THAN ONE agent)

When the client has (or grows into) a second deployed agent — an ops agent
next to the company assistant, a specialist per business unit — they will ask
for the agents to talk to each other. Dispatch is the governed way: one
declared **edge** per direction, human identity carried across the hop.

The concept in one breath: the caller mounts the peer as a remote subagent
(`remotePeer` under `agent/subagents/` — eve's `defineRemoteAgent` underneath,
durable park→callback dispatch, so a reply comes back on the SAME edge); the
receiver authors `agent/channels/eve.ts` with `dispatchChannel({ trustedPeers })`,
which feeds one peer list into BOTH the OIDC subjects allowlist and
`trustedForwarders`. Forwarding is on by default: the receiving agent runs as
the human who asked, so Arcana scoping, per-user connections, and PostHog
attribution compose across the hop unchanged (`eve:forwarded-by` records the
edge for audit).

**Don't hand-wire it — use the `connect-agents` Claude Code skill** (in the
seeded `.claude/skills/`): tell Claude "connect <agent A> to <agent B>" and it
reads both repos, writes the edge with a routing description derived from the
callee's REAL capabilities, sets the URL env var, and walks the deploy+verify
steps. `kyb doctor` then checks the edges (env var set, no `() => true`
trust, forwardPrincipal present).

Client-conversation rules of thumb:

- One edge = ask-and-answer in one direction. Mirror-image edge only if the
  other agent should also INITIATE. Quote them separately.
- **Both ends must run compatible eve versions** — an old receiver silently
  drops principal forwarding and runs the session as the calling app's
  service identity. Upgrade edges as a unit (`kyb upgrade` both repos).
- Peers are pinned to production deployments of named Vercel projects.
  Previews never get trust implicitly. The client's Vercel team is still the
  outer boundary, same as §4.3b.
- Cross-ORG edges (client agent ↔ another company's agent) are a different
  product conversation — purpose-scoped grants, §2.5 disclosures. Don't wire
  one as if it were internal.

**Governed mode (dispatch ≥0.2.1 + enterprise ≥0.2.0 + the client's control
plane) — the preferred form.** Edges become GRANTS in the admin instead of
code: register both agents (/agents, OPEN production alias, health 200), grant
the edge on the CALLEE's panel (caller + purpose + optional expiry), mint each
agent's credential (shown once) into KYBERNESIS_AGENT_CREDENTIAL on its
deployment. Code shrinks to remotePeer({ callee: "<EXACT registered name —
case-sensitive>", governed: { issuer }, envVar, fallbackUrl }) and
dispatchChannel({ governed: { issuer, agent } }). Outbound auth is a 300 s A2A
token minted per edge; the callee URL comes from the registry (discovery), env
var still wins. THE DEMO: revoke the edge in the admin → the caller is refused
(edge_not_granted) within 5 minutes, no redeploy; re-grant → restored. Run it
for the client — it's the whole governance story in one minute. Full lifecycle
proven live 2026-08-07 (kyber ↔ eve-gtm). Budget note: the deployed agent and
local eval runs share the project's AI Gateway budget — size it for both.

### 4.4 Author the agent's identity and instructions

How instructions work in eve (30 seconds of mechanics): a flat
`agent/instructions.md` is the whole prompt; an `agent/instructions/`
**directory** combines entries alphabetically (root file first) and accepts
both `.md` and `.ts` files — a `.ts` entry wraps `defineInstructions` (built
once at compile time) or `defineDynamic` (resolved per session, like the
surface.ts example below). Keep always-on instructions to identity, tone, and
standing rules; procedures belong in skills (§4.3e) — the model loads those on
demand instead of paying for them every turn.

Crib the structure from `~/kyber/agent/instructions/identity.md`, which has
three sections worth copying:

1. **Identity** — who the agent is, and *how to write for Slack*: short paragraphs,
   bullets, no headings unless the answer is genuinely long. Slack is a chat surface, not
   a document editor. Agents default to essay mode; say otherwise explicitly.
2. **Delegation** — name each subagent and say when to route to it. Critically:
   *"a specialist sees none of this conversation, so pack everything it needs into the
   message."* Subagents do not inherit context. Without this line the agent delegates
   half-briefed and the specialist answers badly.
3. **Surfaces** — what public channels mean versus DMs, and what to say when someone
   asks for something personal in a channel.

For per-session context, `defineDynamic` on `session.started` lets you inject
surface-specific instructions. `~/kyber/agent/instructions/surface.ts` is a working
example: it greets a DM session by the caller's verified name and reminds a channel
session that everything it posts is public.

**Author these with Claude Code (§4.0), and judge drafts by test, not by
reading** — paste the discovery notes, have it draft identity.md and the
client skills, then run §4.4b and the evals. Instructions are prompts under
test: every rule in our own identity.md exists because an eval or a live turn
caught the opposite behavior.

### 4.4b Test-drive in `eve dev` — before any connector exists

You do not need Slack, credentials, or a deploy to exercise the agent:

```bash
cd ~/work/acme-atlas
npm run dev        # boots the local runtime and opens the dev TUI
```

Talk to it in the TUI and walk the behaviors you just authored, in roughly
this order — each line catches a different class of wiring mistake:

1. **Identity**: "who are you, what can you do?" — does the persona match
   identity.md, and does it write chat-length answers?
2. **Skill routing**: ask something a skill covers *without naming the skill*
   — watch for the `load_skill` call. If it doesn't fire, the skill's
   `description` isn't written as a triggering task.
3. **Delegation**: ask a department question — watch the subagent call and
   check the answer came back briefed (§4.4's "pack everything" rule).
4. **Memory**: "remember that X" then ask for it back — the recall-first rule
   in action against the real (eval-workspace!) Arcana.
5. **Engineer layer** (if installed): ask for a small page + screenshot — the
   first local sandbox turn proves the hosted-sandbox credentials work.

Notes that save an afternoon: the TUI's local principal counts as a **DM**
surface (so `requireDm` tools are reachable locally); `npx eve info` is the
compile/discovery truth (0 diagnostics before moving on); **kill the dev
server before `npm run eval`** — a running instance makes evals attach to it
(§4.8); and the TUI is NOT the deployed agent — Slack runs the deployed build,
redeploy after every change (§11).

### 4.5 Build the department subagents

One directory per department under `agent/subagents/<dept>/`:

```
agent/subagents/finance/
├── agent.ts
├── instructions.md
├── connections/
│   └── arcana.ts
└── skills/
    ├── recall/SKILL.md
    ├── remember/SKILL.md
    └── brain-note/SKILL.md
```

`agent.ts` — **the `description` is the routing signal.** The root agent sees only this
string when deciding whether to delegate. Write it as a list of the nouns people
actually say:

```ts
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Finance specialist: financials, budgets, spend, revenue, invoices, runway, and " +
    "financial reporting. Keeps the finance team's own memory workspace. Delegate any " +
    "finance-shaped task, question, or reporting request here.",
  model: "anthropic/claude-sonnet-5",
});
```

**Two hard constraints on subagents, both of which will bite you:**

1. **Subagents inherit nothing — give each its own mount.** On eve ≥0.30 a
   declared subagent mounts extensions locally: drop
   `agent/subagents/<dept>/extensions/arcana.ts` (an `arcana({ apiKey,
   workspace })` mount with that department's scoped key) and only that
   subagent gets the connection + skills + instructions. This is the default
   pattern now. The plain-connection alternative below still works (it's what
   pre-0.30 required, and what you'll find in older kyber subagents) when you
   want the connection without the shipped skills:

   ```ts
   // agent/subagents/finance/connections/arcana.ts
   import { arcanaBrain } from "../../../lib/arcana";

   export default arcanaBrain({
     description:
       "The finance team's long-term memory (Arcana): remember, recall, search, " +
       "timeline, and brain notes for financial work.",
     defaultWorkspace: "acme-finance",
     workspaceEnvVar: "ARCANA_FINANCE_WORKSPACE",
     keyEnvVar: "ARCANA_FINANCE_API_KEY",
   });
   ```

   The factory resolves the key in this order: the eval key when the workspace has been
   overridden to `acme-eval`, then the department's own key, then the root
   `ARCANA_API_KEY` as a fallback. That ordering is what makes hermetic eval runs work
   without a second copy of every file.

2. **Subagents have no user principal, so Vercel Connect OAuth is impossible in them.**
   Any connection a subagent needs must use a static token from an env var — an org
   service account, not a per-user grant. Plan the client's integrations accordingly.

### 4.6 Schedules (optional)

`agent/schedules/*.ts` for anything recurring — a Monday pipeline summary, a Friday
financial report. **Schedules live on the root agent only**; a scheduled root turn
delegates to the subagent that owns the work. `~/kyber/agent/schedules/friday-financials.ts`
is the working example: it fires Friday 02:00 UTC, delegates to `finance`, and DMs the
result to a configured Slack user. Note that DMing a user from a schedule needs the
`im:write` scope on the Slack connector — add it during Phase 5 or the first run fails
silently at the last step.

### 4.6b Observability — evlog → PostHog (the Operate-phase deliverable)

One hook file gives the agent per-turn structured telemetry — who talked,
which tools/subagents fired, timings, token usage, outcome — with message
text redacted and tool-failure turns always kept:

```ts
// agent/hooks/evlog.ts
import { defineEvlogHook } from "evlog/eve";
import { createPostHogDrain } from "evlog/posthog";

export default defineEvlogHook({
  init: { env: { service: "acme-atlas" } },
  // mode "events" is REQUIRED for dashboards: the default "logs" mode
  // ships OTLP to the separate PostHog Logs product — invisible to
  // Activity/insights, and it looks exactly like "no events arriving".
  drain: createPostHogDrain({ mode: "events" }),
  redactMessage: true,
});
```

Env: `POSTHOG_API_KEY` = the **project** key (`phc_…`, ingestion-only — a
`phx_…` personal key is account-privileged and wrong here). The default host
is `https://us.i.posthog.com`; EU-hosted projects need
`POSTHOG_HOST=https://eu.i.posthog.com` or events silently vanish. To verify
region + key in one shot, curl a test event at each region's `/batch/` and
see which appears in Activity. Turns then land as `evlog_wide_event` — build
the starter insights on its properties: turns/day by surface, tool failure
rate, delegation mix, p50/p95 duration.

**Person attribution (optional — a DISCLOSURE item, §2.5):** wide events carry no
userId by default, so PostHog sees one anonymous actor named after the service. To
attribute turns to the verified speaker, add a sibling hook that stamps the
per-message-authenticated principal via evlog's `useLogger` — on `step.started`, not
`turn.started`, so evlog's turn state exists regardless of hook ordering (crib
`~/kyber/agent/hooks/attribution.ts`). Then a one-time $identify per person maps ids
to names. Per-employee telemetry must be a deliberate, disclosed choice at a client.

### 4.7 Environment variables

Two places must agree: `.env.local` for local development, and the Vercel project's
environment for anything deployed.

```bash
# .env.local (never commit; .gitignore already covers it)
KYBERNESIS_ISSUER=https://agent.kybernesis.ai
KYBERNESIS_AGENT=atlas

SLACK_CONNECTOR_UID=slack/atlas

ARCANA_API_KEY=kb_...                    # root / company brain key
ARCANA_COMPANY_WORKSPACE=acme-company
ARCANA_DM_WORKSPACE=acme-dm

ARCANA_FINANCE_API_KEY=kb_...
ARCANA_FINANCE_WORKSPACE=acme-finance
ARCANA_ENGINEERING_API_KEY=kb_...
ARCANA_ENGINEERING_WORKSPACE=acme-engineering

ARCANA_EVAL_API_KEY=kb_...               # the acme-eval workspace key
```

Push them to Vercel (repeat per environment; mark secrets **Sensitive**):

```bash
cd ~/work/acme-atlas
vercel env add ARCANA_API_KEY production
vercel env add ARCANA_API_KEY preview
vercel env add ARCANA_API_KEY development
```

> **Read this twice.** `eve deploy` runs a `vercel env pull` afterwards and
> **overwrites `.env.local`**. The Vercel project environment is the source of truth. If
> you add a variable locally and then deploy, your local edit is gone. Always add to
> Vercel first, then pull.

### 4.8 Evals — the QA deliverable

The baseline suite is a package. Do **not** hand-write or copy eval files:

```bash
cd ~/work/acme-atlas
eve add @kybernesis/evals
```

That installs `@kybernesis/evals` and writes two files: `evals/evals.config.ts`
(judge model — **never the model under test** — generous timeout, gentle
concurrency) and `evals/kybernesis.eval.ts`, which you configure for this agent:

```ts
// evals/kybernesis.eval.ts
import { kybernesisBaseline } from "@kybernesis/evals";

export default kybernesisBaseline({
  agentDisplayName: "Atlas",
  // engineer: true,   // when the engineer layer is installed — adds the vision-loop eval
  routing: [
    { subagent: "finance" },
    { subagent: "marketing" },
    { subagent: "engineering" },
  ],
});
```

You get: a **smoke** eval (boots, replies, identifies itself), five **memory**
evals (greeting must NOT thrash memory; explicit remember never refused;
proactive store of company decisions; brain-note write+index two-step, in
order; a fact stored in one session recalled **unprompted** from a brand-new
session), and one **routing** eval per department you list. Every fixture
encodes a hardening lesson we paid for in production (in-test nonces, per-run
unique keys, company-general wording, suffix-based tool matching, realistic
delegation timeouts) — the package README explains each one. **Do not "clean
up" the fixture patterns**; each odd-looking choice fixes a real bug.

Wire the hermetic run into `package.json` so every Arcana workspace is forced
to `acme-eval` and evals never write into a real brain:

```jsonc
"scripts": {
  "eval": "ARCANA_COMPANY_WORKSPACE=acme-eval ARCANA_DM_WORKSPACE=acme-eval ARCANA_FINANCE_WORKSPACE=acme-eval ARCANA_ENGINEERING_WORKSPACE=acme-eval eve eval",
  "typecheck": "tsc"
}
```

Run them:

```bash
cd ~/work/acme-atlas
npm run eval
```

Certification-run hygiene (each of these ate a real run on 2026-08-06):

- **Kill any stale `eve dev` first** — a leftover dev server makes `eve eval`
  attach to the old instance and silently run stale code (or refuse to run).
- **Do not touch the repo while the suite runs.** The dev runtime watches
  `agent/`; an edit mid-run breaks the rebuild and kills the remaining evals.
- **No Docker anywhere.** The workshop backend is pinned to Vercel Sandbox —
  local eval runs create hosted sandboxes with the linked project's
  credentials (`vercel link` + `vercel env pull` first; `kyb doctor` checks
  the token) and reuse the deploy-prewarmed template (engineer eval ≈3–4 min
  warm, measured). If you eval BEFORE the first deploy, the first run bakes
  the hosted template — evals ≥0.2.1 budget 20 minutes for that.
- If eve complains about a sandbox migration or templates re-bake every run,
  the local cache is stale from a framework version hop:
  `rm -rf .eve/sandbox-cache .eve/dev-runtime` and rerun.

Client-specific evals go in separate files beside `kybernesis.eval.ts`, built
from the same primitives the package exports (`isResultFrom`,
`MEMORY_READ_SUFFIXES`, …). Two traps the package can NOT absorb for you — see
§10: a running dev server on port 2000 makes `eve eval` exit early, and
governed agents (`@kybernesis/enterprise`) need `localDev()` in their auth walk
for local eval runs (the registry's enterprise template includes it — don't
remove it).

---

## 5. Deploy (Day 3, ~30 minutes)

### 5.1 Slack connector (needs the client's Slack admin present)

```bash
cd ~/work/acme-atlas
vercel connect create slack --triggers --name atlas
```

This opens a browser flow against **the client's Slack workspace**. The display name you
set here is what employees see. Two things to do inside that flow:

- Open **Advanced** and add `message.channels` under **Trigger Event Types** and
  `channels:history` under **Bot Scopes** — these are what make thread-following work.
  Private channels also need `message.groups` and `groups:history`. Add `im:write` if you
  built a schedule that DMs someone.
- Note the connector UID it gives you (e.g. `slack/atlas`) and put it in
  `SLACK_CONNECTOR_UID`.

Then re-point the trigger at eve's Slack route. eve does not serve Connect's default
path, so this detach/attach pair is mandatory:

```bash
vercel connect detach slack/atlas --yes
vercel connect attach slack/atlas --triggers --trigger-path /eve/v1/slack --yes
```

### 5.2 Pre-flight, then deploy

```bash
cd ~/work/acme-atlas
npm run typecheck        # 0 errors
npx eve info             # 0 discovery diagnostics
npx eve deploy
```

Treat "0 errors, 0 warnings" as a gate, not a goal. `eve info` warnings are almost always
a file eve did not discover the way you thought.

### 5.3 Verify the deployment

```bash
curl -s https://acme-atlas.vercel.app/eve/v1/health
# expect {"ok":true}
```

Substitute the real deployment URL that `eve deploy` printed. Keep that URL — Phase 6
needs it.

> **The single most common failure mode in this entire playbook:** you change something,
> test it in `eve dev`, it works, you try it in Slack, and it does not. **Slack talks to
> the deployed build.** Every change needs `npx eve deploy` before Slack sees it. Say this
> out loud to yourself once per day.

### 5.4 Green eval baseline

```bash
cd ~/work/acme-atlas
npm run eval
```

A green suite is the deliverable you hand the client. Wire it into their CI before you
leave (a GitHub Action running `npm run typecheck && npm run eval` on pull requests,
with the Arcana eval key and gateway credential as repository secrets).

---

## 6. Control-plane wiring (Day 3, ~15 minutes, in the browser)

Go to <https://agent.kybernesis.ai> and switch to the **ACME org**.

### 6.1 Register the agent

**Agents → Register agent.**

- **Name:** `atlas` — this **must** exactly equal `KYBERNESIS_AGENT` in the deployed
  environment. A mismatch produces `403 agent_not_granted` for a user who genuinely has
  the grant, and it is a maddening thing to debug at a demo.
- **Runtime:** **▲ eve deployment** (the default).
- **Deployment URL:** the URL from §5.3.

The row now shows an **▲ eve** badge, the deployment URL, and a live health dot the
control plane probes from `<deploymentUrl>/eve/v1/health`. If the dot is red, the control
plane cannot reach the deployment — check Vercel deployment protection before you check
anything else.

### 6.2 Invite the humans

**Users → Invite.** Invite the client's admins first, then the pilot cohort from your
discovery table. Give the client admins `manage`; everyone else gets `use`.

### 6.3 Grant the agent

**Grants.** Grant `atlas` to each pilot user (or to a team, if you created one). Level
`use` for the cohort, `manage` for admins.

Alternatively, set the agent's access tier to `org` so every org member gets it
implicitly. For a pilot, prefer explicit grants — the whole demo in §8 depends on grants
being visibly individual.

### 6.4 The one timing rule you must internalize

**Grants are resolved at mint time.** The identity token and policy bundle a user holds
are a snapshot of their access at the moment they signed in.

- Grant someone *after* they signed in → they do not have it until their session is
  re-minted (a refresh, or a fresh sign-in).
- Revoke someone → their **current** token keeps working until it expires. Default TTL is
  1 hour (`IDENTITY_TOKEN_TTL_SECONDS`). **That TTL is the off-boarding SLA. Tell the
  client the number.** If an hour is too long for them, tune it — the cost is more
  frequent refreshes.
- **Suspend** someone → minting refuses entirely. That is the immediate lever, and it is
  the one to use for a real off-boarding.

---

## 7. Pilot onboarding — the humans (Day 4)

The technical work is done. This day decides whether the pilot succeeds.

### 7.1 Set up the shared channel

Invite the agent to the client's chosen channel (`/invite @atlas`). Post a short pinned
message the champion can point at:

> `@atlas` is our company agent. Mention it in this channel to ask something, and it will
> keep replying in that thread without needing another mention — so you can just talk.
> DM it for anything personal; DMs use a separate memory from this channel. Type `/new` in
> a DM to start over. It remembers what you tell it, so telling it something once is
> enough.

### 7.2 Run a 30-minute group session with the cohort

Do this live, in the shared channel, with everyone watching. Demonstrate, in order:

1. **Mention it and ask a real question.** Use something from their actual work, not a
   toy.
2. **Have a second person reply in the same thread without mentioning it.** This is the
   moment the room understands it is not a chatbot. Point out that the agent knows who
   said what.
3. **Tell it a fact** — "our Q3 board meeting is on the 12th" — then start a **fresh
   thread** and ask about it. Cross-session recall is the second moment.
4. **Ask a department question** and let it delegate. Show that the finance specialist
   has its own knowledge.
5. **Ask something personal in the channel** and let it refuse and redirect to a DM. Then
   do it in a DM. This teaches the surface model better than any explanation.

### 7.3 Train the client admins separately (15 minutes)

Walk the two admins through the control plane themselves — do not do it for them:

- Invite a user.
- Grant `atlas`.
- Revoke it, and watch what happens (§8.3).
- Suspend a user, and watch minting refuse.

Tell them the timing rule from §6.4 in these words: *"Suspend is immediate. Revoke takes
effect within an hour. Grant takes effect the next time the person signs in."*

### 7.4 Set expectations honestly

Say these four things to the cohort, in plain language:

- Anyone in this Slack workspace can talk to the agent. Per-person access control on the
  Slack door is not built yet; the control-plane grants govern the HTTP/desktop door.
- Approval buttons in a shared thread can be clicked by anyone in that thread. Do not use
  the agent for anything destructive in a shared channel yet.
- Everything it learns in a public channel is shared with everyone in that channel.
- It is a week old at your company. It will be wrong. Tell the champion when it is, and
  those corrections become instructions and evals.

---

## 8. Acceptance demo script (Day 5, ~20 minutes, in front of the client's sponsor)

Run this as a script. Rehearse it once alone first. Every step below has been executed
against production.

### 8.1 Slack — the agent works (5 min)

- [ ] Mention `@atlas` in the shared channel with a real question → coherent reply in
      thread.
- [ ] A second person replies in the thread with no mention → agent continues, and its
      answer reflects who is speaking.
- [ ] DM `@atlas` → it responds as a personal assistant.
- [ ] In the DM, type `/new` → "Started a fresh conversation."

### 8.2 Memory — it actually learns (5 min)

- [ ] In the channel: tell it a company fact.
- [ ] Start a **fresh thread**: ask about that fact → it recalls it.
- [ ] Ask a department question → it delegates, and the answer comes back synthesized.
- [ ] Show the client their own memory, in their own workspace:
      ```bash
      curl -s -H "Authorization: Bearer $ARCANA_API_KEY" \
        -H "X-Kyberagent-Agent: acme-company" \
        "https://api.arcana.kybernesis.ai/brain/acme-company/timeline?limit=5"
      ```

### 8.3 Governance — the demo that sells the product (10 min)

This is the part the sponsor remembers. Do it live; do not screenshot it.

**Step 1 — sign in as a granted employee.** Start the device flow:

```bash
curl -s -X POST https://agent.kybernesis.ai/api/oauth/device \
  -H 'content-type: application/json' \
  -d '{"deviceId":"fde-demo","deviceLabel":"FDE laptop"}'
```

You get back `device_code`, `user_code`, `verification_uri`,
`verification_uri_complete`, `expires_in: 600`, `interval: 5`. Open
`verification_uri_complete` in a browser and approve as the employee.

**Step 2 — exchange the device code for a session:**

```bash
curl -s -X POST https://agent.kybernesis.ai/api/oauth/token \
  -H 'content-type: application/json' \
  -d '{"device_code":"PASTE_DEVICE_CODE"}'
```

Before approval this returns RFC 8628 error codes (`authorization_pending`, and so on).
After approval it returns an **IdentitySession** plus a `refresh_token`:

```json
{ "issuer": "https://agent.kybernesis.ai",
  "token":  "<compact JWS — iss, sub (userId), org, email, org_name, exp>",
  "bundle": "<compact JWS — user, org, agentGrants:[{agent,level}], allowedAdapters, exp>",
  "jwks":   { "keys": [ "...public ES256 keys..." ] } }
```

**Step 3 — call the agent with the two headers:**

```bash
TOKEN=...   # the "token" field
BUNDLE=...  # the "bundle" field

curl -s -i -X POST https://acme-atlas.vercel.app/eve/v1/sessions \
  -H "authorization: Bearer $TOKEN" \
  -H "x-kybernesis-bundle: $BUNDLE" \
  -H 'content-type: application/json' \
  -d '{"input":"Hello"}'
```

The session streams. Say out loud what just happened: *the agent verified that token
offline, against a public key, with no call back to us.*

**Step 4 — show the failure mode first.** Call the same endpoint with no headers:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://acme-atlas.vercel.app/eve/v1/sessions
# 401
```

**Step 5 — the revoke.** In the admin UI, revoke that employee's grant for `atlas`. Then
have them sign in again (repeat steps 1–2) and call the agent with the **fresh** token:

```
HTTP/1.1 403 Forbidden
{"error":"agent_not_granted", ...}
```

**Step 6 — the suspend.** Suspend the user in the admin UI. Try to mint again — the
control plane refuses to issue a session at all. This is the off-boarding lever.

**Step 7 — restore.** Re-activate and re-grant, sign in once more, and show access
returning. Leave the client's world as you found it.

Then state the SLA plainly: *"Suspension is immediate. A revoked employee's already-issued
token stops working within the token TTL — one hour by default, tunable."*

### 8.4 Sign-off checklist

- [ ] Slack: mention, thread continuation, DM, `/new`
- [ ] Memory: store, cross-session recall, delegation, visible in their Arcana workspace
- [ ] Governance: 401 → grant → 200 → revoke → 403 → suspend → mint refused → restored
- [ ] Health: `<deployment>/eve/v1/health` returns `{"ok":true}` and the control plane's
      health dot is green
- [ ] Evals: `npm run eval` green, running in their CI
- [ ] Admins have done an invite, a grant, and a revoke **with their own hands**

---

## 9. Handover (Day 5)

### 9.1 What the client owns and receives

- **The repo** — in their GitHub org, if they want it. Push it there and add their
  engineers. It is their source.
- **The Vercel project** — theirs already. Confirm their team owns it, not your personal
  scope, and that at least two of their people have deploy access.
- **The Slack app** — installed in their workspace, owned by their admin.
- **Their Arcana workspaces** and the scoped keys. Hand these over through a password
  manager, not Slack.
- **Control-plane admin access** — invite, grant, revoke, suspend is their entire
  operational surface, and after §7.3 they know how to use it.
- **The eval suite**, running in their CI.
- **Optionally Eve Studio** for employees who do not live in Slack — note that Studio
  sign-in against the control plane is specced but **not built yet** (§11).

### 9.2 What Kybernesis keeps doing

- **Operating the control plane** at `agent.kybernesis.ai` — issuer, keys, grants,
  audit. (Unless they self-host, in which case we support their instance.)
- **Maintaining and versioning the packages** — `@kybernesis/arcana`,
  `@kybernesis/enterprise`, `@kybernesis/multiplayer`. Version bumps are our work; the
  client's eval suite is the gate that proves an upgrade is safe.
- **Operating Arcana** — the memory SaaS their brains live in.
- **Per-client eve version pins** (`eve_agent_deployment.eve_version_pin`) so a framework
  release never surprises a client mid-quarter.
- **The maintenance retainer** — which is what all of the above justifies. Frame it that
  way in the handover conversation: they own the agent, we own the platform underneath it.

### 9.3 Leave-behind document

Write a one-page README in their repo covering: the deployment URL, the control-plane
org URL, which Arcana workspace maps to which subagent, the env var list (names only,
never values), how to run the evals, and — in bold — **redeploy after every change,
because Slack runs the deployed build.**

---

## 10. Troubleshooting appendix

Grouped by where the pain shows up. Every entry here cost someone real time.

### Environment and deployment

**My `.env.local` changes disappeared.**
`eve deploy` runs `vercel env pull` afterwards and overwrites `.env.local`. The Vercel
project environment is the source of truth. Add to Vercel first, then pull.

**I changed something and Slack still does the old thing.**
Slack talks to the **deployed** build. Run `npx eve deploy`. This is the number one
support question and it will be yours too.

**`eve dev` won't start / `eve eval` exits immediately.**
Something is already on port 2000 (eve dev's default). Find and kill it:
```bash
lsof -ti tcp:2000 | xargs kill
```
`eve eval` boots its own host and exits early if the port is taken.

**Vercel CLI does nothing useful in a script.**
Non-interactive `vercel` calls need the team: add `--scope <team-slug>`. `eve link` is
interactive-only; in CI use `vercel link --project <name> --yes --non-interactive`.

**The control plane's health dot is red but `curl` works for me.**
Vercel deployment protection. A protected preview or production deployment rejects the
control plane's unauthenticated health probe. Check the project's Deployment Protection
settings.

### Arcana / memory

**Everything Arcana returns 403.**
`kb_` keys are **workspace-scoped**. A key minted for `acme-finance` gets `403` on
`acme-company`. Check that the key env var and the workspace env var for that mount refer
to the same workspace. Validate in isolation:
```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer kb_..." \
  -H "X-Kyberagent-Agent: acme-finance" \
  "https://api.arcana.kybernesis.ai/brain/acme-finance/timeline?limit=1"
```

**Memory tools are missing entirely from a subagent.**
Subagents inherit nothing from the root — the root's arcana mount does not reach them.
Give the subagent its own local extension mount
(`agent/subagents/<id>/extensions/arcana.ts`, eve ≥0.30) or a plain connection file
plus skill copies (§4.5).

**The agent says "I don't have anything stored about that" without looking.**
The `@kybernesis/arcana` instructions carry a never-claim-ignorance-without-searching
rule and a recall→search escalation rule (an empty entity recall does **not** mean nothing
is stored). If you overrode or trimmed the instructions, you dropped those rules. Put
them back — an eval caught this exact failure.

**Arcana MCP tool names don't match the docs.**
Tool names are qualified by the mount namespace. Mounted as `agent/extensions/arcana.ts`,
`arcana_remember` is addressed as `arcana__memory__arcana_remember`. Run `npx eve info` to
see the actual resolved names rather than guessing.

**Should I use Vercel Connect OAuth for Arcana?**
No. Use a static `kb_` key. Connect OAuth works in the `eve dev` TUI and is broken in
production (Connect beta: "couldn't find this authorization request"; grants also do not
cross environments). This is settled — see the `arcana-eve` skill for the full analysis.

### Governance / auth

**A user who definitely has the grant gets `403 agent_not_granted`.**
Three causes, in order of likelihood: (1) the agent's registered name in the control plane
does not exactly equal `KYBERNESIS_AGENT` in the deployed environment; (2) the grant was
added *after* the user signed in and their token predates it — grants resolve at mint
time, so refresh or re-sign-in; (3) you are pointing at the wrong org's issuer.

**Everything returns 401.**
Missing, malformed, or expired credentials — or only one of the two headers. Both are
required: `authorization: Bearer <token>` **and** `x-kybernesis-bundle: <bundle>`. Also
check `KYBERNESIS_ISSUER` matches the issuer that minted the token.

**A revoked employee can still use the agent.**
Expected, for up to the token TTL (1h default). Grants resolve at mint; already-issued
tokens are not revoked mid-flight. For immediate cut-off, **suspend** the user — minting
refuses entirely. Tune `IDENTITY_TOKEN_TTL_SECONDS` if the client needs a tighter SLA.

**I can't `curl` my own agent locally.**
The governed `agent/channels/eve.ts` drops `localDev()` and `placeholderAuth()` — it fails
closed by design. Drive it through the `eve dev` TUI, or mint a real token via the device
flow.

### Slack

**Slack delivers nothing.**
The trigger is still on Connect's default path. eve does not serve that path. Run the
detach/attach pair with `--trigger-path /eve/v1/slack` (§5.1).

**Only @mentions arrive; thread-following doesn't work.**
Missing scopes. The connector needs the `message.channels` trigger event and the
`channels:history` bot scope (plus `message.groups` / `groups:history` for private
channels). `threadContext` needs the same history scopes.

**The agent replies to itself, or to other bots.**
eve drops messages authored by the installed app before your hook runs, but *other* bots
are still visible. The multiplayer package filters `message.author?.isBot`; if you hand-
rolled a hook, do the same.

**A scheduled DM never arrives.**
The connector needs `im:write`. The schedule otherwise runs fine and fails at the last
step, which makes it look like the schedule did not fire.

### Evals

**Evals pass locally then fail identically twice in a row after a fix.**
eve caches compiled eval modules across runs. Avoid module-level nonces (no
`const id = Date.now()` at module scope) — generate per-run values inside `test()`.

**A routing eval times out.**
Delegation does real memory work in the subagent. Routing evals need roughly six-minute
timeouts. Set `timeoutMs` in `evals.config.ts` or pass `--timeout`.

**An eval fails because the agent refused.**
Certain phrasings trip the model's own safety behavior — "canary codeword" reads as a
secret-extraction attempt. Use neutral wording ("project codename").

**Evals wrote test data into the real brain.**
The `eval` npm script must override **every** Arcana workspace env var to `acme-eval`.
Miss one and that subagent writes into production memory. Check the script against your
actual list of subagents.

**`npm run eval` looked green in CI but the job passed when it shouldn't have.**
Piping eval output to `tail` (or anything else) masks the exit code. Use
`set -o pipefail`, or don't pipe.

### Packages and the registry

**`eve add @kybernesis/...` 404s.**
Either the registry namespace is not registered in this project (`eve registry add
@kybernesis=https://registry.kybernesis.ai/r/{name}.json`), or that item is not published
yet. Check what actually exists with `npx eve registry list --registry @kybernesis`, or
hit the item URL directly: `curl -s -o /dev/null -w "%{http_code}\n"
https://registry.kybernesis.ai/r/multiplayer.json`.

**`eve add` resolved the item but the npm install failed.**
The registry item and the npm package are published separately, and the registry item can
land first. That is exactly the state `@kybernesis/multiplayer` is in as of 2026-08-05.
`npm view @kybernesis/<name> version` tells you which half is missing.

**`npm install @kybernesis/<something>` says the version doesn't exist, right after publish.**
New packages and versions take one to three minutes to propagate to anonymous reads, even
after `npm access` reports them public. Wait, then retry.

**Publishing a new package in the `@kybernesis` scope fails.**
Only the `kybernesis` npm account can **create** packages in the scope; `ianborders` can
publish new versions of existing ones. Publishing needs Ian's browser auth (npm web-login
flow). This is a Kybernesis-internal step, not something to do at a client site.

**A published package imports fine locally but breaks on clean install.**
`tsc` does not rewrite import specifiers. An extensionless ESM re-export in `dist/` works
in a workspace and fails from the registry. `@kybernesis/enterprise@0.1.0` shipped with
exactly this bug; `0.1.1` fixed it with explicit `.js` extensions. Always test a package
change with a **clean install into a scratch project**, never only from the workspace.

**A script's JSON output is polluted with warnings.**
pnpm writes engine warnings to stdout. Pipe through `pnpm --silent` and, if needed,
`sed -n '/^{/,$p'` to strip everything before the first JSON line. (This mostly bites in
the control-plane repo's seed scripts.)

### General

**Something isn't being picked up and I can't see why.**
`npx eve info` first, always. It prints exactly what eve discovered plus diagnostics, and
it is far faster than booting the dev server. `npx eve logs` reads the last `eve dev`
diagnostic log if you need stderr, tool failures, and rebuild lines.

---

## 11. Known gaps — state these plainly, do not sell around them

Being straight about these is a feature. Clients have met vendors who were not.

1. **Slack access is workspace membership, not a grant.** Anyone in the client's Slack
   workspace who can see the bot can talk to it. Control-plane grants govern the HTTP and
   desktop doors, not the Slack door. The fix is a planned
   `governedSlackChannel()` module in `@kybernesis/enterprise` plus `external_identity`
   mapping (the schema exists; the module does not). Scope pilots to shared channels where
   workspace membership is an acceptable boundary.

2. **HITL approvals are session-scoped, not person-scoped.** eve renders approval buttons
   in the thread, and any thread member can click them. Do not gate destructive actions on
   thread-visible approvals in a shared channel. Person-scoped approvals — only the
   requester or a `manage`-grant holder may approve — are the planned governance half in
   `@kybernesis/enterprise`.

3. **Eve Studio sign-in is specced, not built.** Employees who do not live in Slack have
   no polished desktop door yet; HTTP access is token-by-hand via the device flow. The
   implementation brief is in [[kybernesis-architecture-and-studio-signin]].

4. **Off-boarding SLA equals the token TTL** (1h default) for already-minted sessions.
   Suspension is immediate; revocation is not. Tune `IDENTITY_TOKEN_TTL_SECONDS` to the
   client's appetite and tell them the number.

5. **Multiplayer is Slack-only in v1.** The `/discord` and `/whatsapp` subpaths are
   reserved for the same core with thin adapters, but nothing is built. Also: one turn at
   a time per session — simultaneous speakers resolve in arrival order, with mid-turn
   messages folded into the next turn best-effort.

6. **Per-user OAuth into personal SaaS and local-file work (the device bridge) are future
   builds.** Org service accounts with static tokens cover most pilot asks. Subagents in
   particular *cannot* use per-user OAuth at all — no user principal.

7. **DM memory is per-workspace, not per-employee, unless you build it.** Splitting DMs
   into one Arcana workspace per person needs a Slack-user-id → workspace-slug map in the
   header resolver plus workspace provisioning. Doable; not shipped as a package.
