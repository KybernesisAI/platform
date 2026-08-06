---
description: "Record engineering decisions, project state, and ship events to long-term memory so future sessions inherit the context. Use after decisions, scaffolds, ships, and at the end of significant work sessions."
---

# Architecture Notes — the project remembers

When the agent has Kybernesis Arcana memory (the normal setup), engineering
context must OUTLIVE the session. Session 40 should know what session 1
decided and why. Without notes, every session is an amnesiac rebuild.

## What to record, and with which memory tool

| Event | Tool (remote names; call via their qualified names) |
| --- | --- |
| A decision with rationale (framework choice, schema shape, tradeoff taken) | Brain note: `arcana_brain_write` + `arcana_brain_add` — always both |
| A ship (what/when/URLs) | `arcana_remember` |
| Project state at session end ("dashboard: auth done, charts WIP in agent/branch-x") | `arcana_remember` |
| A gotcha discovered (build quirk, env dependency, flaky test) | `arcana_remember`, tagged to the project |

## Decision-note structure

```
## <Decision> — <date>
**Context**: why a decision was needed
**Decision**: what was chosen
**Rationale**: why this option won
**Alternatives considered**: what else was evaluated
**Implications**: what this commits us to
```

## The recall half

Before starting work in a project, look it up: `arcana_recall` on the project
name, `arcana_search` for the area you're touching. The brain may already
hold the decision you're about to re-litigate — honor it or explicitly
supersede it with a new note, never silently contradict it.
