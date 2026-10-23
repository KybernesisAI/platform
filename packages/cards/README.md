# @kybernesis/cards

Rich replies for eve agents. One card format that tools emit and Kybernesis clients draw, with a plain-text version for channels that cannot draw cards, and a reader that turns a session stream into the steps an agent took.

A reply has three layers: the words, the steps (each tool call as a short chip and one line), and cards for the things the agent made. KYBER Studio on the desktop and the phone draw all three. Text-only channels get the words and each card's text.

## The card

```json
{
  "kyb": 1,
  "card": "stats",
  "id": "c_7f3a91",
  "title": "Website · last 7 days",
  "source": "Analytics",
  "data": { "tiles": [{ "label": "Visitors", "value": "12,480", "change": "+8%", "tone": "good" }] },
  "actions": [{ "label": "Break it down by source", "say": "Break it down by source" }],
  "text": "Website, last 7 days: Visitors 12,480 (+8%)"
}
```

Types: `stats`, `chart`, `table`, `checklist`, `brief`, `link`, `screenshot`, `file`, `artifact`, `pull-request`, `receipt`, `remembered`, `routine`. A client that does not know a type draws its `text`. A later card with the same `id` replaces the earlier one in place.

Rules: a card is data, never markup (HTML belongs in an artifact, which runs sandboxed); links are only http(s) or paths on the agent's own address; cards are capped (fifty table rows, four chart series) so they stay small; secrets never go in a card.

## Emitting cards from a tool

Put the cards under `kyb` in the tool's output, and give the model a version without them. eve keeps the full output on the `action.result` stream event, which is where clients read it, and `toModelOutput` only changes what the model sees.

```ts
import { defineTool } from "eve/tools";
import { card, forModel, withCards } from "@kybernesis/cards";

export default defineTool({
  description: "Weekly website numbers.",
  inputSchema: z.object({}),
  async execute() {
    const week = await readAnalytics();
    return withCards(week, card("stats", { tiles: week.tiles }, { title: "Website · last 7 days", source: "Analytics" }));
  },
  toModelOutput: forModel,
});
```

A question can carry a card too: pass `cardPrompt(card, sentence)` to `ctx.ask`. Text channels should show `promptText(prompt)`, which drops the marker line.

## Reading a stream

```ts
import { cardsOf, newStepState, readStep, visibleSteps } from "@kybernesis/cards";

const state = newStepState();
for (const event of events) readStep(state, event.type, event.data, event.meta);
visibleSteps(state.steps.values()); // [{ chip: "Analytics", label: "Pageviews, last 7 days", status: "done", … }]
cardsOf(state.steps.values());      // the cards, newest version of each
```

A step's line is eve's own activity label when the tool defines `label` (eve 0.81), otherwise a readable form of the tool name.

No dependencies. Works in Node, a browser and React Native.
