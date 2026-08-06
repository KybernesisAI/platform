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

## Composes with

`@kybernesis/arcana` (the architecture-notes skill writes decisions to the
project brain) · `@kybernesis/enterprise` (governance) · `@kybernesis/evals`
(`engineerSuite()` / `kybernesisBaseline({ engineer: true })`) · the official
`agent-browser`, `github-tools`, and `vercel` registry items.
