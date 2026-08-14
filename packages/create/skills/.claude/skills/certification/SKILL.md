---
description: Use when running evals, certifying an agent or an eve version bump, debugging eval failures, or preparing a release — the Kybernesis QA discipline and its run hygiene.
---

# Certification & eval discipline

The rule: **evals gate every deploy, and the consuming agent's suite is the
release gate for every package change.** Nothing ships on "it looks right" —
green suite or it doesn't go.

## The suite

`kybernesisBaseline()` from `@kybernesis/evals` in `evals/kybernesis.eval.ts`:
smoke (boots, replies, identifies itself), five memory evals (no memory
thrash on greetings; explicit remember never refused; proactive storage;
brain-note two-step in order; cross-session unprompted recall), one routing
eval per department, and with `engineer: true` the vision-loop eval
(screenshot tool fires and the judge confirms the model SAW the render).
Judge model is configured in `evals/evals.config.ts` and must NEVER be the
model under test.

## Run hygiene (each rule ate a real run)

- `npm run eval` — always through the npm script: it forces every Arcana
  workspace to `<name>-eval` so evals never write into a real brain.
- **Kill any running dev server first** (`pkill -f "eve dev"`) — eve eval
  attaches to an existing instance and runs stale code.
- **Never edit the repo mid-run** — the dev runtime watches `agent/`; an
  edit breaks the rebuild and kills remaining evals.
- Engineer eval: hosted Vercel sandbox (no Docker), needs `vercel link` +
  `vercel env pull` (VERCEL_OIDC_TOKEN). Warm template ≈3–4 min; a
  pre-first-deploy cold bake is budgeted 20 min.
- Stale sandbox state (migration errors, re-baking templates):
  `rm -rf .eve/sandbox-cache .eve/dev-runtime` and rerun.
- Don't pipe the eval command through `tail` in scripts — it masks the exit
  code (and `| tail -N` on a backgrounded run destroys the per-eval detail —
  `tee` to a file instead).
- **Heavy-model suites: `maxConcurrency: 1` locally.** At 2, long opus turns
  overload the local world-queue transport (`Queue delivery failed … fetch
  failed`); crashed deliveries REPLAY subagent steps, surfacing as
  `lost continuationToken` races and phantom failures that move between runs.
  The deployed runtime uses real queue infra — this is a local-harness limit.
- **AI Gateway budget is a silent eval killer**: Vercel applies a default
  per-project budget (e.g. $10/daily); a suite of real opus turns can exhaust
  it MID-RUN → `MODEL_CALL_FAILED` on whatever ran last. Check/raise:
  `vercel ai-gateway budgets list` / `budgets set project <name> --limit 30
  --refresh-period monthly`.
- **"run parked on N unanswered input request(s)"** = the agent called a
  human-in-the-loop tool (`approval: status=pending tool=ask_question` in the
  turn log) — no one answers in an eval. Usually a behavior finding: the
  fixture was self-contained and the agent asked instead of acting. Fix the
  agent's bias-to-act instructions, not the fixture.

## eve version certification

Clients pin the **Kybernesis-certified** eve version (`kyb upgrade` carries
them there — never blind npm-latest). Certifying a new eve: bump in a branch
→ typecheck → `npx eve info` → full suite → live smoke on the deployed
surface → advance the pin in @kybernesis/create → record the certification.

## When an eval fails

Read the eval's transcript before touching fixtures. Order of suspicion:
(1) environment (stale dev server, missing env, cold template), (2) a real
behavior regression — fix the agent, (3) only THEN the fixture — and if a
fixture changes, the reason becomes a comment on it. A failure that reveals
a new failure mode becomes a new fixture: that is how the suite grew every
guard it has.

## Release flow (packages)

Edit in `~/platform` → build → bump → human publishes (browser auth) →
consuming agent bumps → **full suite green** → deploy → registry item update
+ deploy if install files changed. Then propagate the lesson (see the
`source-of-truth` skill).
