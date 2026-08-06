---
description: "The core build-iterate-verify loop for any coding task in the sandbox. Use whenever writing or changing code: run the dev server, typecheck, test, and VISUALLY verify with the screenshot tool before claiming anything is done."
---

# Dev Loop — build, run, look, repeat

Your sandbox is a real dev machine with a persistent `/workspace` that survives
between turns and sessions — treat it like your own workstation, not a scratch
buffer. The project you started yesterday is still there.

## The loop (every change goes through all four)

1. **Change** — edit files with the file tools; keep changes small and coherent.
2. **Check** — `npm run typecheck` (or the project's equivalent) and the test
   suite. A type error or failing test means the loop restarts; never proceed
   past red.
3. **Run** — start the dev server as a long-lived process and probe it:
   the server keeps running while you work; `curl -s http://localhost:3000`
   confirms it responds before you look at it.
4. **Look** — call the screenshot tool with `url: "http://localhost:3000/..."`
   and **examine the pixels**. Does it match the intent? Layout broken? Text
   overflowing? Wrong colors? If yes → back to step 1. Check the key
   viewports: desktop (1024×768 default) and mobile (390×844) for anything
   user-facing.

## Definition of done (all four, no exceptions)

- Typecheck passes
- Tests pass
- The dev server serves without errors
- **You have LOOKED at a screenshot of the result and it matches the intent**

"The code looks correct" is not done. Done is *seen working*.

## Sandbox habits

- Long-running processes (dev servers, watchers) stay alive across your tool
  calls within a turn; kill and restart them when config changes.
- Screenshots are saved under `/workspace/.screenshots/` — re-take rather than
  reference old ones (older image parts are dropped when history compacts).
- Install project deps inside the project dir, not globally; the workshop
  template already carries the toolchain and browsers.
