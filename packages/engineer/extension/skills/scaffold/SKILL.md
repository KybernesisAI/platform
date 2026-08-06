---
description: "Start a new web project or app in the sandbox with the standard stack. Use when asked to build a site, app, dashboard, or landing page from scratch."
---

# Scaffold — starting a project right

## Default stack (deviate only if the brief demands it)

Next.js (App Router) + TypeScript + Tailwind. Scaffold non-interactively:

```
npx create-next-app@latest <name> --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --yes
```

Work inside `/workspace/<name>`. If the client's repo already exists, clone it
instead (git credentials are brokered — plain `git clone` works for permitted
hosts; tokens are never visible to you).

## First moves after scaffolding

1. `npm run dev` as a long-lived process → confirm it serves.
2. Screenshot `http://localhost:3000` — verify the scaffold renders before
   writing any feature code (catches broken scaffolds in one step).
3. Commit the clean scaffold as the first commit (see the git-discipline
   skill) so every later diff is meaningful.

## Structure conventions

- One feature per file/component; pages thin, components extracted.
- Keep styling in Tailwind classes; add a design-token block in
  `globals.css` only when the brief specifies brand colors.
- No new dependency without a reason you could defend in review — prefer the
  platform (Next.js, Tailwind) over utility packages.

## When the brief includes services

Databases, auth, payments and similar external services are provisioned
through the project's existing connections/integrations — check what tools
you have (Vercel connection, GitHub tools) before hand-rolling anything, and
record the choice with the architecture-notes skill.
