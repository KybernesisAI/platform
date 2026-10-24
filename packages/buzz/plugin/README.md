# Kybernesis cards for Buzz

A Buzz desktop plugin that draws the cards a Kybernesis agent posts (charts, tables, checklists,
stats, artifacts) as cards, in the conversation. The agent's bridge (`@kybernesis/buzz` 0.13 or
later) posts each card as its own message with the card in a hidden HTML comment; this plugin
replaces those messages' bodies with the card. The components are `@kybernesis/cards-react`.

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

A signed release names its publisher in Buzz, and only that publisher can ship updates to it.
After `npm run build` (which empties `release/`, so an old signature never outlives its build),
sign the folder and commit the two files it writes:

```sh
buzzodz plugin sign release   # writes plugin.artifact.json + plugin.signature.json
```

`buzzodz plugin sign` signs with the Buzz identity saved on that computer. Every later release must
be signed by the same publisher; changing publisher means everyone removes and reinstalls.

