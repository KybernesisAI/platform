---
description: "Look up what is known about a person, project, company, place, or topic from the workspace brain. Use proactively whenever someone mentions a name, references a project or company, asks about past interactions, or says who is, what do we know about, tell me about, or recall."
---

# Recall — Primary Memory Retrieval

This is the **primary memory retrieval path**. The Arcana brain (entity graph,
timeline, fact store, embeddings) is the authoritative knowledge store. The
tools live on the memory connection; their remote names are `arcana_recall`,
`arcana_search`, `arcana_timeline`, and `arcana_brain_stats`. Call them by the
qualified name your session surfaces (use `connection_search` for "memory" or
"arcana" if they are not yet loaded).

## When to Fire

**ALWAYS** look up when someone asks about or mentions any person, project,
company, place, topic, past decision, history, or context. Do not wait for the
word "recall" — if a name or entity comes up and you don't already have fresh
context from this session, look it up immediately. Never say "I don't know" or
"there's nothing stored about that" without a search coming back empty first.

**Always look up when:**
- Someone mentions a person by name and you lack recent context about them
- A project or company is discussed and you need background
- Someone asks "what do we know about...", "who is...", "tell me about..."
- You're about to give advice and historical context would improve it
- A meeting or event is referenced and you need details
- The question involves past decisions, conversations, or interactions

**Don't look up:**
- Entities you already retrieved in this session
- Generic nouns that aren't specific entities ("the project" without a name)
- When the person is clearly giving you information, not asking for it

## How to Recall

1. **Identify the entity** — use the most specific form available ("Sarah
   Chen", not "Sarah").
2. **Query the brain** with the right tool:
   - Entity lookup (people, companies, projects): `arcana_recall({ entity })`
   - Time-based context: `arcana_timeline({ today: true })`,
     `({ week: true })`, or `({ search: "<keywords>" })`
   - Semantic search (anything not tied to one entity):
     `arcana_search({ query })`
3. **Escalate before giving up** — an empty `arcana_recall` does NOT mean the
   brain lacks the answer; it means no *entity* matched. Follow up with
   `arcana_search({ query })` (semantic + keyword) and, for recent items,
   `arcana_timeline({ search })`. Only an empty `arcana_search` justifies
   "nothing stored about that".
4. **Use the context** — synthesize, don't dump. If nothing is found, answer
   normally without mentioning the lookup.

## Examples

- "I need to follow up with Jake" → `arcana_recall({ entity: "Jake" })`
- "Why did we go with PostgreSQL?" → `arcana_recall({ entity: "PostgreSQL" })`
  + `arcana_search({ query: "PostgreSQL decision rationale" })`
- "What do you know about me?" → `arcana_brain_stats`, a search on the
  person's name/role, `arcana_timeline({ week: true })`, then synthesize.

## Notes

- Combine recall (entity graph) + timeline (temporal) + search (semantic) for
  the most complete picture.
- After a conversation surfaces new information, store it with the `remember`
  skill so future recall finds it.
