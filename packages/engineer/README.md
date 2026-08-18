# @kybernesis/engineer

Engineer capabilities for [eve](https://eve.dev) agents: a **vision-verified
dev loop** — the agent renders its work in a real browser inside its sandbox,
takes a screenshot, and *sees the pixels* before claiming anything is done —
plus the trade-school skills and discipline rules for building and shipping
real software.

## What ships in the package

| Contribution | What it does |
| --- | --- |
| `tools/screenshot` | Renders a `url` (running dev server) or `html` in in-sandbox Chromium and returns the screenshot to the model as an image content part — the agent's eyes. Captures are also saved under `/workspace/.screenshots/` |
| `skills/dev-loop` | The core loop: change → check → run → **look**. Definition of done includes a seen screenshot |
| `skills/scaffold` | Starting projects right (Next.js + TS + Tailwind defaults, first-commit discipline) |
| `skills/visual-qa` | The screenshot critique pass: desktop + mobile viewports, honest self-review |
| `skills/git-discipline` | Branch-per-task, atomic commits, PRs with evidence, the never-list |
| `skills/ship` | Preview freely, promote only through explicit human approval, verify production |
| `skills/architecture-notes` | Record decisions/ships/state to Arcana memory; recall before re-litigating |
| `instructions.md` | Always-on engineering conduct: definition of done, production is sacred, screenshots are look-now |

## Install

The extension is only half the story — the **workshop sandbox** (Playwright
baked into the sandbox template) is a consumer-authored file the extension
cannot carry. Install both via the Kybernesis registry:

```bash
eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
eve add @kybernesis/engineer   # writes agent/extensions/engineer.ts AND agent/sandbox/sandbox.ts
```

Or scaffold a full engineer-capable agent from nothing:

```bash
npm create @kybernesis acme-builder -- --engineer
```

(`kyb init --engineer` also adds the official companions: `extension/agent-browser`,
`extension/github-tools`, `connection/vercel`.)

## The workshop sandbox

`agent/sandbox/sandbox.ts` (registry-written, yours to own):

- **Template bootstrap**: pnpm + Playwright + Chromium bake into the sandbox
  TEMPLATE — the first session pays minutes once; every later session starts
  warm and completes a full render→screenshot→vision loop in ~6 seconds
  (measured).
- **Domain allowlist on deployed sessions** (Vercel Sandbox backend): npm,
  GitHub, Playwright CDNs, Debian mirrors, Vercel, the AI gateway, Google
  Fonts. A blocked host fails loudly — extend the list deliberately; every
  addition is a security decision. Local dev (Docker) runs allow-all (Docker
  supports only allow-all/deny-all).
- `/workspace` persists across turns, sessions, and agent redeploys — a
  project the agent started last week is still there.

## Verified behavior (the hidden-stamp proof)

The vision loop was proven with an adversarial test: a random code stamped
into the screenshot's **pixels** and hidden from the model's view of the tool
result — the model read it correctly 3/3 (cold + warm runs). The proof rig
lives at `fixtures/eyes-spike` in the platform repo, and `engineerSuite()`
in `@kybernesis/evals` pins the behavior per deployment.

## Operational notes

- Image parts are re-sent on every later model call and **dropped on
  compaction** — screenshots are "look now"; durable artifacts live as files
  in the sandbox (the tool saves every capture).
- Keep viewports modest; the tool refuses screenshots that would exceed safe
  image-part size.
- Deploy design: preview deploys via the project's Git integration and the
  Vercel connection; **production promotion is human-approved at the moment
  of promotion** (the ship skill enforces the posture; wrap promote-shaped
  connection tools with `approval: always()` for a hard gate).


## Pushing without handing over a credential

`@kybernesis/engineer/git` holds the pieces a host wires into its own sandbox
and tools. The point of all three is that they decide things the model would
otherwise be asked to get right in prose.

```ts
import { brokeredGitPolicy, httpsRemote, refuseBranch } from "@kybernesis/engineer/git";

// The credential attaches to egress for one host. Nothing inside the sandbox
// can read it, because it was never in there — no token in the environment,
// none in the remote URL, none in anything the model writes or prints.
const sandbox = await use({ networkPolicy: brokeredGitPolicy({ token }) });

// Name the remote literally. Remote config inside a sandbox is writable, so a
// push to `origin` can be pointed at a host the broker never authorized — and
// the header would go with it.
await sandbox.run({ command: `git push ${httpsRemote(repo)} ${branch}` });

// And refuse before running, not after: the default branch is exactly where a
// confused agent pushes.
const refusal = refuseBranch(branch);
if (refusal) return refusal;
```

`refuseBranch` also rejects `refs/heads/main` and `HEAD` — the same place
under another name — and any branch carrying shell metacharacters, since the
name reaches a command line.

## Composes with

`@kybernesis/arcana` (the architecture-notes skill writes decisions to the
project brain) · `@kybernesis/enterprise` (governance) · `@kybernesis/evals`
(`engineerSuite()` / `kybernesisBaseline({ engineer: true })`) · the official
`agent-browser`, `github-tools`, and `vercel` registry items.
