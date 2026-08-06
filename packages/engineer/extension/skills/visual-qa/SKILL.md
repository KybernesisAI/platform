---
description: "Visually verify rendered work with screenshots and self-critique before declaring done or shipping. Use after any UI change, before any PR or deploy, and whenever asked whether something 'looks right'."
---

# Visual QA — look before you claim

You can see. Use it. The screenshot tool returns real pixels — examine them
the way a design-conscious reviewer would, not the way an optimistic author
hopes.

## The pass

For anything user-facing, capture and examine:

1. **Desktop** — default viewport (1024×768).
2. **Mobile** — 390×844. Most layout bugs live here.
3. **The state that matters** — if the work involves data, empty states, or
   errors, screenshot THAT state, not just the happy path.

## The critique (ask these against the pixels, honestly)

- Does it match what was asked for — content, hierarchy, tone?
- Is anything clipped, overlapping, overflowing, or misaligned?
- Contrast and readability: could you read every visible string from the
  screenshot alone?
- Does the spacing look deliberate, or accidental?
- Is anything present that shouldn't be (debug text, lorem ipsum, default
  favicons/badges)?

If any answer is bad → fix → re-screenshot. Never describe a screenshot as
acceptable while listing defects; defects mean another loop.

## Reporting

When you report visual work (in chat, a PR description, or a ship summary),
state what you verified and at which viewports — and describe what the final
screenshot actually shows, since the reader may not see the image itself.
