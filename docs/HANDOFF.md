# Kybernesis platform — fresh-machine handoff

Read this first when working from a machine that isn't Ian's main computer.
It orients a fresh Claude Code session on everything the Kybernesis stack is,
where it lives, and how to fix things. Last full update: **2026-08-08**.

## The repos (all github.com/KybernesisAI, SSH remotes)

| Repo | What it is | Deploys to |
| --- | --- | --- |
| `platform` (this repo, PUBLIC) | The product monorepo: seven npm packages under `@kybernesis/*`, the eve registry source (`registry/`), governed-ref + fixtures. **The FDE Claude Code skill suite lives here** (`packages/create/skills/`, mirrored into `.claude/skills/` of every repo) and carries most operational knowledge. | npm + `registry.kybernesis.ai` (Vercel project `platform-registry` — deploy from `registry/` with `vercel deploy --prod`) |
| `kyber` | Our own company agent (eve): Slack, Arcana memory, 3 dept subagents, engineer layer, governed dispatch edge to eve-gtm. The reference implementation clients' agents copy. | Vercel `kyber` → `https://kyber-ten.vercel.app` |
| `eve-gtm` | The GTM operator agent (repo name on old machines may be `eve-content-agent-template` — same repo). Proactive Slack nudges on 4 cron schedules, content + research subagents, governed dispatch edge to Kyber. | Vercel `eve-gtm` → `https://eve-content-agent-template-one.vercel.app` |
| `kybernesis-admin` | The control plane: org/users/teams, user→agent grants, **agent→agent edge grants + agent credentials + A2A minting** (`/api/agent/session`), ES256 issuer + JWKS. Migrations run on deploy (`vercel-build`). | Vercel `kybernesis-admin` → `https://agent.kybernesis.ai` |
| `kybernesis-company` | Private company library (password-gated). **The `/fde` section is the browsable knowledge base**: full technical docs, the engagement playbook as per-section pages, packages + downloadable skills. | Vercel `kybernesis-company` → `https://company.kybernesis.ai` |
| `arp` | Ian's Agent Relationship Protocol (dormant prototype). Reference/spec for future cross-org agent federation (Phase 2). Not deployed. | — |

## Where knowledge lives (in priority order)

1. **The skill suite** — `.claude/skills/` in this repo (and kyber/eve-gtm), canonical
   source `packages/create/skills/`. Seven skills: fde-engagement (+ THE CANONICAL
   PLAYBOOK at `fde-engagement/references/playbook.md`), eve-building,
   kybernesis-packages, control-plane, certification, connect-agents, source-of-truth.
   Every production-learned gotcha is encoded there. A fresh clone of this repo gives
   Claude Code all of it automatically.
2. **company.kybernesis.ai/fde** — the same material as browsable, per-section docs
   (system end-to-end, CLI reference, versioned stack, deploying eve), the playbook,
   and package/skill downloads. Password-gated; works from any browser.
3. **The admin** — `agent.kybernesis.ai`: live state of agents, grants, edges.
4. Ian's Obsidian (iCloud): `kybernesis-system-overview.md` and the A2A research docs —
   deeper internal state narrative, syncs to his devices, not needed to operate.

## Current state snapshot (2026-08-08)

- **eve pin: 0.49.0** (Kybernesis-certified 2026-09-02 on Kyber 17/18 + Ava 7/7;
  do NOT bump without the certification flow in the certification skill). The
  0.38.3 → 0.49.0 move broke two things a typecheck never sees — `disableTool()`
  files for `glob`/`grep` (removed from the default set in 0.39; `kyb upgrade`
  migrates them) and eve 0.45's OpenAI `safety_identifier` (the exe gateway
  rejects it; `@kybernesis/exe` strips it). eve 0.49 also has first-class memory
  slots; `@kybernesis/arcana/memory` is the provider and `kyb add memory` the
  slot. 0.31.0 is the migration wall: it
  replaced continuation-token session APIs with ID-addressed handles, so anything
  crossing it moves together. Remote-agent CALLBACKS do not work between hosts that
  cannot reach their own public URL — use governed peers, which poll a stream instead.
- **Package versions on npm**: enterprise 0.2.0 · arcana 0.2.0 · multiplayer 0.1.0 ·
  engineer 0.2.0 · dispatch 0.2.1 · evals 0.2.1 · create 0.3.2. All Apache-2.0, public.
  Publishing needs Ian's npm login (`kybernesis` account); `publishConfig.access=public`
  is set on dispatch/create — pass `--access public` explicitly for the others.
- **Live and proven E2E** (all during 2026-08-06 → 08-08):
  - Engineer layer in kyber: build → self-screenshot → preview-deploy → deliver files
    via public Blob URLs.
  - Agent-to-agent Phase 0 + **Phase 1 (governed)**: kyber ↔ eve-gtm on `dispatch`
    governed mode — 300 s A2A tokens minted from the control plane per granted edge,
    registry-as-discovery, person attribution across the hop, and the **revoke demo**
    (revoke edge in admin → caller refused ≤5 min → re-grant → restored, no deploys).
  - Both agents' eval suites 10/10 (22 gates) on the published packages.
  - PostHog observability (project "Kyber"): evlog wide events, person attribution,
    Operations + Users dashboards.
- **Phase 2 (cross-org edges, ARP ConnectionToken/scope catalog)**: designed, gated
  until the first engagement with two trust domains. Design docs in Ian's Obsidian;
  verdict summary in the connect-agents + kybernesis-packages skills.

## Fresh-machine setup (≈15 min)

1. Clone what you need (usually `platform` + whichever agent repo is broken).
2. `npm install` per repo. Node 24.x. eve repos: `npx eve info` must show 0 errors.
3. `vercel link` inside each deployable repo (team `ian-darkstarvccs-projects`,
   project names as in the table) then `vercel env pull` — env vars (Arcana kb_ keys,
   `KYBERNESIS_AGENT_CREDENTIAL`, PostHog, Slack connector) all live in Vercel env,
   nothing is only-on-the-old-machine.
4. Agent repos: `npm run eval` green BEFORE and AFTER any fix (hermetic eval workspace
   is wired into the npm script). Then `npx eve deploy`.
5. `npx @kybernesis/create@latest doctor` in any agent repo = full preflight.
6. Watch the AI Gateway budget: `vercel ai-gateway budgets list` — deployed agents and
   local eval runs share each project's budget (eve-gtm is $100/monthly for this reason).

## Non-negotiable disciplines (see source-of-truth skill)

- The playbook's canonical home is `packages/create/skills/fde-engagement/references/playbook.md`
  — edit there, bump create, re-seed `.claude/skills/` copies. Obsidian + company-site
  copies are mirrors.
- Lessons get encoded where the next run hits them: doctor check > eval fixture >
  skill > playbook. If you can't point at where a lesson now lives, the work isn't done.
- Never edit an agent repo while its eval suite is running. Kill stale `eve dev` first.
