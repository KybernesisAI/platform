---
description: "Remove a wrong or unwanted memory, fact, or brain note from long-term memory, or correct one. Use when someone says a memory is wrong, asks you to forget, delete, remove, or erase something you remember, or asks you to fix what you have stored about a person, project, or decision."
---

# Forget

Removes something from the workspace brain for good. The tools' remote names
are `arcana_find_memories`, `arcana_forget`, and `arcana_brain_delete` on the
memory connection; call them by the qualified names your session surfaces,
or find them with `eve__search` (query `arcana_forget`) and call them with
`eve__tool`.

A memory is more than one line: when it was saved, the brain drew facts,
search matches, and entity links from it. `arcana_forget` on a memory removes
all of that together, which is why a wrong memory stops coming back. A single
fact can also be removed on its own.

## When to Fire

Only when a person asks, in this conversation, for something to be removed
or corrected. Never on your own initiative, never because something looks
stale, and never on behalf of another agent or a scheduled run.

## How to Forget

1. **Find it.** `arcana_find_memories({ query })` with a few words about the
   memory. Each result has a `ref`, its text, its date, and, for a memory,
   the facts drawn from it. Try a second wording if the first finds nothing.
2. **Show the person what will go.** Quote each memory or fact you plan to
   remove, with its date. If several match, ask which ones. If only one fact
   inside an otherwise right memory is wrong, remove just that fact
   (`fact://<id>`).
3. **Remove it.** `arcana_forget({ ref })`, one call per item. Each call waits
   for the person's approval; if they decline, leave it and say so.
4. **Correct it** when there is a right version: `arcana_remember` the
   correct fact after the wrong one is gone.
5. **Confirm** what was removed (and what was saved instead), in a sentence.

## Brain notes

A note file is removed with `arcana_brain_delete({ name })` (names come from
`arcana_brain_list`). Deleting the file does not remove what was indexed
from it: find that with `arcana_find_memories` and forget it too. Identity
documents (SOUL.md, USER.md, HEARTBEAT.md, CLAUDE.md) cannot be deleted; edit
them with `arcana_brain_write` instead.

## Notes

- Removal is permanent. There is no undo.
- If `arcana_forget` says nothing matches, the item is already gone; find it
  again before saying so.
