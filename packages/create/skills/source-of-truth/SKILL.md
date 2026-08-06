---
description: Use whenever a lesson is learned, a bug is fixed, a package/registry/playbook/doc changes, or something shipped — the checklist that keeps the Kybernesis knowledge system the single source of truth. Also use when unsure where a piece of knowledge belongs.
---

# Source of truth — and how it stays that

The knowledge system only works if every change lands in the right place the
same day it happens. This skill is the routing table and the checklist.

## Where truth lives

| Kind of knowledge | Canonical home |
| --- | --- |
| How to run an engagement | `packages/create/skills/fde-engagement/references/playbook.md` (THIS package) — the Obsidian copy is a mirror, never edit it first |
| How to build eve agents / packages / control plane / certification | the sibling skills in `packages/create/skills/` |
| Package behavior + install steps | each package's README + registry item in `~/platform` |
| Framework truth | `node_modules/eve/docs/` at the pinned version — never restate at length, point at it |
| What exists, what's specced, what's parked | the system-overview doc (session-handoff master, Obsidian) |
| Session-to-session working context | the Claude project memory (`~/.claude/projects/.../memory/`) — pointers and lessons, not content that belongs above |

Secrets live in env managers only. Client-specific facts live in the client's
repo and brain, never in this suite.

## The propagation checklist — run it whenever any of these happens

**A live failure taught something / a gotcha was paid for:**
1. Encode it where the next run will hit it: a skill in this suite, a package
   README, an eval fixture, or a `kyb doctor` check — prefer executable
   guards (doctor/evals) over prose.
2. If it changes engagement procedure → edit `references/playbook.md` here,
   then copy to the Obsidian mirror.
3. Bump `@kybernesis/create`, build, commit — the human publishes.
4. Add one line to the Claude project memory if future sessions need it
   before they'd naturally read this suite.

**A package changed (version, API, install steps):**
1. README + registry item updated in the same commit as the change.
2. Consuming agent bumped, suite green (the release gate), deployed.
3. Version references in the playbook §3.4 pin list + system overview updated.
4. If install/setup steps changed → the relevant skill here too.

**Something new was built or shipped:**
1. System overview: move it into "shipped and verified" with the evidence.
2. Playbook: add the operational steps if an FDE will ever repeat them.
3. This suite: extend the matching skill (or add one) if Claude needs it.

**A framework (eve) version was certified:**
1. Advance the pin in `@kybernesis/create` (`EVE_VERSION`).
2. Check every skill/playbook claim that names framework behavior — versions
   change what's true (example: "subagents cannot mount extensions" was true
   on 0.29, false on 0.30, and stale in four places until a maintainer
   review caught it).

## The standing rule

If you (Claude) finish a piece of work and cannot point at where its lesson
now lives, the work is not done. When unsure where something belongs, the
answer is almost always "the most executable place that the next person or
agent will actually hit" — doctor check > eval fixture > skill > playbook >
memory, in that order of preference.
