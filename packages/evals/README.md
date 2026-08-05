# @kybernesis/evals

Baseline eval suites for Kybernesis-built [eve](https://eve.dev) agents — the QA
deliverable of every engagement, packaged. One file in a client agent yields the
full hardened regression suite; improvements ship to every deployment as a
version bump.

## Install

```bash
npm install --save-dev @kybernesis/evals
```

Or via the Kybernesis registry (also writes the eval file and config):

```bash
eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
eve add @kybernesis/evals
```

## Usage

Eve eval files may default-export an **array** of evals (dataset fan-out) — so
a client's entire baseline is one file:

```ts
// evals/kybernesis.eval.ts
import { kybernesisBaseline } from "@kybernesis/evals";

export default kybernesisBaseline({
  agentDisplayName: "Atlas",
  routing: [
    { subagent: "finance" },
    { subagent: "marketing" },
    { subagent: "engineering" },
  ],
});
```

Plus a standard `evals/evals.config.ts` (judge model, timeout, concurrency) and
a hermetic-workspace script in `package.json`:

```jsonc
"scripts": {
  "eval": "ARCANA_COMPANY_WORKSPACE=<client>-eval ARCANA_DM_WORKSPACE=<client>-eval eve eval"
}
```

Run `npm run eval` locally; `eve eval --strict --junit .eve/junit.xml` in CI.

## What the baseline covers

| Suite | Evals | Gates on |
| --- | --- | --- |
| `smokeSuite` | 1 | Boots, replies, identifies itself (judge, soft) |
| `memorySuite` | 5 | No memory thrash on greetings · explicit remember never refused · proactive store of company decisions · brain-note write+index two-step, in order · **unprompted** cross-session recall of a fresh fact |
| `routingSuite` | 1 per subagent | The right specialist gets delegated (real 6-min budget) |

`kybernesisBaseline(config)` composes all three. Suites are individually
exported for à-la-carte use, and the tool-matching primitives
(`MEMORY_READ_SUFFIXES`, `isResultFrom`, …) are exported for writing
client-specific evals in the same style.

## The hardening this package encodes (why fixtures look the way they do)

These defaults exist because each one failed in production first:

1. **Nonces are generated inside `test()`** — eve caches compiled eval modules
   across runs; module-scope `Date.now()` evaluates once, forever.
2. **Per-run unique fact keys** — the hermetic eval workspace *accumulates*
   across runs. Repeated identical facts make a good agent decline duplicates;
   contradictory facts make recall surface stale answers. Unique keys per run
   keep every assertion self-consistent.
3. **Company-general wording** — department-flavored fixtures make a
   delegation-capable agent *correctly* route to a subagent, whose tool calls
   happen in a child session that parent-stream predicates cannot see.
4. **No security vocabulary** — "canary codeword" fixtures get refused as
   secret-extraction attempts instead of searched.
5. **Suffix-based tool matching** — qualified names differ by mount style
   (`arcana__memory__arcana_remember` vs `arcana__arcana_remember`); suffix
   matching survives all of them.
6. **Realistic delegation timeouts** — a routed task runs a full child session
   doing real memory work; 180s budgets produce false failures.

Do not "clean up" these patterns in consumer evals — each one reintroduces a
bug this package fixed.

## Requirements & interplay

- **Memory suite** assumes `@kybernesis/arcana` is mounted and a dedicated
  `<client>-eval` Arcana workspace + key exist (never point evals at a real
  brain).
- **Governed agents** (`@kybernesis/enterprise`): the local eval runner sends
  no credentials, so the agent's auth walk must include `localDev()` after
  `kybernesisAuth()` — loopback-only and production-inert, but required for
  `npm run eval` to reach a governed agent locally. The registry's enterprise
  template includes it.
- **Judge-backed assertions** need a judge model in `evals.config.ts` and
  gateway credentials (`VERCEL_OIDC_TOKEN` via `vercel link`/`env pull`, or
  `AI_GATEWAY_API_KEY`).
- Multiplayer channel behavior (thread continuation, per-speaker attribution)
  is **not HTTP-testable** and is deliberately absent; verify it with a live
  Slack smoke test. A channel-level harness is future work.

## Known limits

- Delegated memory writes (a subagent storing to *its* brain) are invisible to
  parent-stream predicates; the baseline avoids fixtures that trigger them. A
  "delegated memory" eval asserting the subagent call plus direct Arcana API
  verification is on the roadmap.
- First runs against a brand-new eval workspace may be slower while Arcana
  indexes cold content; `indexingWaitMs` (default 25s) is configurable.
