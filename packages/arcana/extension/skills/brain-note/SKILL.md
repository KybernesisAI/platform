---
description: "Save long-form knowledge, research findings, architecture decisions, reference material, or structured notes to the workspace brain for persistent retrieval. Use when someone shares detailed information that doesn't fit a single memory, discusses architecture or design decisions, provides reference material, shares meeting notes or research, or says save this to the brain, write this down, document this, or take notes on."
---

# Brain Note

Persists structured, long-form knowledge as a readable markdown file in the
workspace's `brain/` directory AND indexes it into the full pipeline. The
tools' remote names are `arcana_brain_list`, `arcana_brain_read`,
`arcana_brain_write`, `arcana_brain_add`, and `arcana_brain_query` on the
memory connection; call them by the qualified names your session surfaces.

Both halves matter: the file (`arcana_brain_write`) is what shows up in
`/brain/notes` and the web console; the index (`arcana_brain_add`) is what
makes it discoverable via semantic search, entities, and the timeline. Doing
only one leaves the note half-invisible — **always do both**.

## When to Fire

**Always write a brain note when:** an architecture/design decision with
rationale is discussed; research findings should be referenced later; detailed
meeting notes are shared; someone provides reference material or specs; a
complex topic warrants a structured writeup; someone asks to document
something.

**Don't** use a brain note for single facts or events — use the `remember`
skill instead.

## How to Write

1. **Choose the file** — descriptive kebab-case, one topic per note
   (`architecture-decisions.md`, `meeting-notes-2026-08.md`). Check
   `arcana_brain_list({ source: "brain" })` first; if a relevant file exists,
   read it with `arcana_brain_read`, append your new section, and write the
   combined content back.
2. **Compose and write** clear markdown with dates via `arcana_brain_write({
   name, content })`. Decision structure: Context / Decision / Rationale /
   Alternatives considered / Implications. Meeting structure: Attendees /
   Summary / Decisions / Action items.
3. **Index it** via `arcana_brain_add({ content, title, type: "note",
   source_path: "brain/<name>" })`. When appending, index **only the new
   section**, not the whole file again.
4. **Confirm** — mention the filename and title.

## Notes

- Notes are searchable via the `recall` skill and `arcana_brain_query`,
  readable via `arcana_brain_read`.
- Keep notes focused; always include dates.
