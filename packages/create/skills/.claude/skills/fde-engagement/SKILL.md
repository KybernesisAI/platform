---
description: Use when running or planning a Kybernesis FDE client engagement — pilot phases, discovery questions, day-by-day plan, demo script, handover. The operating manual for deploying an eve agent at a client.
---

# Kybernesis FDE engagement

Kybernesis forward-deploys engineers into companies to agentify them: we build
eve-framework agents the client reaches on surfaces they already use (Slack,
iMessage, Telegram, web…), wired to their systems, governed by our control
plane (agent.kybernesis.ai), remembering through Arcana, and quality-gated by
evals. You (Claude) are the FDE's co-builder for all of it.

The complete engagement runbook is `references/playbook.md` — READ THE PHASE
YOU ARE IN before acting. Map of the playbook:

- **Fast path**: `npm create @kybernesis <name> -- [--engineer]` scaffolds the
  entire baseline (governance + memory + multiplayer Slack + evals, optional
  engineer layer). `kyb doctor` checks wiring at any point.
- **Phase 1–2**: pre-engagement checklist; the discovery conversation (agent
  name, departments, SURFACES — never assume Slack, §2.3 — cohort, data
  sensitivities). Leave discovery with the §2.6 table filled in.
- **Phase 3**: environment setup — scaffold, `vercel link`, registry, version
  pins (eve pinned to the Kybernesis-CERTIFIED version, never blind latest).
- **Phase 4**: the build — model pinning (§4.0b), our packages (§4.1–4.3b),
  channels/connections/skills for the client's stack (§4.3c–e), instructions
  (§4.4), `eve dev` test-drive (§4.4b), subagents (§4.5), evals (§4.8).
- **Phase 5–6**: deploy + control-plane registration and grants.
- **Phase 7–9**: pilot onboarding, the acceptance demo script, handover.
- **§10**: troubleshooting appendix — check it before debugging from scratch.
- **§11**: known gaps — state them plainly to the client, never sell around.

Non-negotiables that survive every engagement: production promotion is
human-approved; evals gate every deploy; secrets live in env (Vercel
Sensitive), never in code or memory; every live failure becomes a playbook or
skill edit the same day (see the `source-of-truth` skill).
