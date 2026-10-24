# Kybernesis cards for Buzz

A Buzz desktop plugin that draws the cards a Kybernesis agent posts (charts, tables, checklists,
stats, artifacts) as cards, in the conversation. The agent's bridge (`@kybernesis/buzz` 0.13 or
later) posts each card as its own message with the card in a hidden HTML comment; this plugin
replaces those messages' bodies with the card. The components are `@kybernesis/cards-react`.

Questions too (bridge 0.14 or later): an approval shows the email, event or message it would send,
with Send it, Edit and Don't send; a purchase its amount and Approve in Link; a form its fields.
A press replies to the question as the person, in its thread, so the agent reads it exactly as a
typed answer. A button on a card that says something (Correct it, say) sends that sentence to
the agent the same way.

In a shared channel a question is for the person who asked (bridge 0.15 or later): everyone else
sees it with "Waiting on" and no buttons. When it ends, the bridge edits its own message to say
how, under `kyb:settled`, so every viewer and device shows the outcome instead of the buttons.

Shared artifacts are drawn inside their card with Buzz's browser view (macOS desktop only), shown
while the card sits wholly in the conversation, and open beside it from Open. Other hosts get the
details and a link.

## Install

Settings → Plugins → Manage plugins, enter `KybernesisAI/platform` (Buzz reads it over HTTPS, no
sign-in), pick **Kybernesis cards**, and install. A folder works too: Load from folder and choose
`release/`. `release/` is committed so either way installs without a build.

`release/` also carries `README.md` and `icon.png` from `assets/`, which Buzz shows on its Plugins
screen.

## Build

```sh
npm install
npm run author -- <path to a block/buzz-app checkout>   # the @buzz/author types
npm run build                                           # tsc, then release/plugin.js
```

Buzz lends its own React (`ctx.react`); the build points `react` and `react/jsx-runtime` at
`src/react.ts` and `src/jsx-runtime.ts`, which bind to it in `apply`. The build refuses any output
that is not one self-contained module.

## Sign

A signed release names its publisher in Buzz, and only that publisher can ship updates. The
publisher is Kybernesis, not a person, so `scripts/sign.mjs` signs with a key kept in the
publishing Mac's Keychain (`ai.kybernesis.buzz-plugin-publisher`) instead of `buzzodz plugin sign`,
which can only use the Buzz identity of whoever is signed in. It writes the same NIP-PS pair
Buzz's tool writes; the artifact is byte-identical to buzz-app's own.

```sh
npm run sign -- --create-key   # once, on the publishing Mac
npm run build && npm run sign  # every release; commit release/ including the two signed files
```

`npm run build` empties `release/`, so a signature never outlives its build. Losing the key ends
updates under this publisher (everyone would reinstall), so keep a copy of it somewhere safe.
