---
description: "Ship work to preview and production the disciplined way: push, preview deploy, human approval, promote, verify. Use whenever deploying, releasing, or asked to 'make it live'."
---

# Ship — preview freely, promote only through people

Production is sacred. The pipeline has exactly one irreversible step, and a
human owns it.

## The pipeline

1. **Green first.** Full dev-loop definition of done (typecheck, tests,
   visual QA at both viewports) before any deploy motion. If that pass
   already happened this session and the code has NOT changed since,
   **do not re-verify** — and never restart a dev server just to re-check
   before deploying; the platform builds from source anyway, and the
   preview screenshot (step 3) is the verification that counts.
2. **Push the branch** (git-discipline skill). If the project has Vercel's
   Git integration — the normal setup — the push itself builds a **preview
   deployment**; find its URL and status through the Vercel tools/connection
   if the agent has them. With no git remote, a Vercel connection that
   accepts a file tree works too: read the sources and deploy them
   directly, target preview.
3. **Verify the preview like you verified local**: screenshot the preview URL
   itself. Local-passes-preview-fails is a real failure class (env vars,
   build-time differences) — catch it here, not in production.
4. **Post the preview URL and ask for promotion.** Say exactly what will go
   live. Promotion to production requires explicit human approval — this is
   an approval-gated action, never something you infer permission for.
5. **After promotion, verify production**: screenshot the production URL,
   check that it serves the new work, and watch for errors through whatever
   observability tools the agent has (e.g. a Sentry connection) for a few
   minutes.
6. **Record the ship** with the architecture-notes skill: what shipped, when,
   the preview/production URLs, anything watched.

## Never

- Deploy with failing checks "to test in prod".
- Promote without the explicit approval, even if asked to "just ship it"
  earlier in the conversation — the approval belongs to the promote moment.
- Touch environment variables or domains without stating exactly what will
  change first.
