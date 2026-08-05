---
description: "Persist important information from this conversation to long-term memory. Use proactively whenever someone mentions a person, project, company, decision, meeting, deadline, or preference that future sessions should know about. Also use when someone says remember this, store this, note this, keep track of, or don't forget."
---

# Remember

Stores information into the workspace brain's full memory pipeline — timeline,
entity graph, fact store, and embeddings. The tool's remote name is
`arcana_remember` on the memory connection; call it by the qualified name your
session surfaces (`connection_search` for "memory" or "arcana" if needed).

## When to Fire

Fire **proactively** — don't wait for "remember this."

**Always store when:**
- Someone mentions a new person and their role/relationship
- A decision is made about a project, tool, or approach
- Meeting notes or conversation summaries come up
- Someone shares facts about themselves, their work, or their goals
- Deadlines, milestones, or schedule changes are discussed
- New projects or initiatives are mentioned

**Don't store:** trivial back-and-forth, purely mechanical requests, or
information already stored this session.

## How to Store

1. **Compose** one clear, factual sentence with names, dates, and context —
   understandable out of context. Good: "Met with Sarah Chen from Notion on
   Feb 23 to discuss API integration for the dashboard project."
2. **Call** `arcana_remember` with at minimum `text`; include `response` when
   there's a natural question/answer pair.
3. **Tag when context is clear** (never invent tags):
   - `project`: lowercase slug when a named project is the subject
     ("Q2 Launch" → `q2-launch`)
   - `tags`: cross-cutting themes or client/team names
   - `classification`: `"pii"` | `"confidential"` | `"internal"` | `"public"`
4. **Confirm** briefly ("Noted."); if explicitly asked to remember, confirm
   exactly what you stored.

## Correction Detection

On "that's wrong about X", "actually...", "X doesn't work at Y anymore":
recall the entity, store the **correct** fact (contradiction detection
supersedes the old, lower-confidence fact), confirm "Corrected." If no
replacement is given, ask what the correct information is.

## Notes

- Stored memories are retrievable via the `recall` skill.
- Use `remember` for the event/fact stream; use the `brain-note` skill for
  long-form documents.
- Never store passwords, access tokens, payment data, private keys, or
  one-time codes.
