# @kybernesis/cards-react

React components that draw [`@kybernesis/cards`](../cards) cards. One frame for every card, one body per type, the same in every app that shows them.

```tsx
import { CardStack, cardStyles, type CardContext } from "@kybernesis/cards-react";

const ctx: CardContext = {
  agentUrl,
  openUrl: (url) => window.open(url, "_blank", "noopener"),
  onSay: (text) => send(text),
};

<>
  <style>{cardStyles}</style>
  <CardStack cards={cards} ctx={ctx} />
</>;
```

The host does everything that touches the outside: opening links, fetching pictures and artifacts from the agent, sending a `say` sentence. Leave a callback out and the card draws without it (no Open button, no preview), never broken.

A question the agent is waiting on is an `AskView` (from `askFrom` or `readHiddenAsks` in `@kybernesis/cards`): an approval drawn as the email or event with Send it, Edit and Don't send, a purchase with its amount and Approve in Link, a form with its fields, anything else with its options and a box for words. `onAnswer({ optionId?, text?, label })` is the host's to send; pass `answered` once it is, and it shows the outcome instead of the buttons.

```tsx
<AskView ask={ask} ctx={ctx} answered={answered} onAnswer={(reply) => send(reply)} />
```

Theme it with `--kyb-*` variables on any ancestor: `--kyb-ink`, `--kyb-ink-secondary`, `--kyb-ink-tertiary`, `--kyb-ink-inverse`, `--kyb-surface`, `--kyb-surface-raised`, `--kyb-stroke`, `--kyb-stroke-strong`, `--kyb-hover`, `--kyb-selected`, `--kyb-good`, `--kyb-bad`, `--kyb-font-label`, `--kyb-font-mono`, `--kyb-fs-xs`, `--kyb-fs-sm`, `--kyb-fs-base`, `--kyb-lh-base`, `--kyb-shadow-menu`. Each has a light default.

Artifacts run in a sandboxed frame with no origin and no network. A host whose own content policy blocks scripts in frames passes `renderArtifactHtml` to draw them its own way.
