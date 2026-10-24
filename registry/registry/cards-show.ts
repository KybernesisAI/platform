import { card, forModel, parseCard, withCards } from "@kybernesis/cards";
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Show the person a card: numbers, a chart, a table, a checklist, a brief on a
 * person or company, or a link.
 *
 * KYBER Studio and the phone draw the card under the reply, and the Buzz
 * bridge posts it after the reply for the Kybernesis cards plugin to draw.
 * The model reads only a note that the card was shown, so it doesn't repeat
 * the contents. Slack and iMessage never see tool results, so the reply must
 * still make sense without the card. See @kybernesis/cards.
 */

const tone = z.enum(["good", "bad", "neutral"]).describe("Whether the change is good or bad news. Up is not always good.");
const tile = z.object({
  label: z.string().describe("What the number is, e.g. Visitors"),
  value: z.string().describe("Already formatted, e.g. 12,480 or 2.5%"),
  change: z.string().optional().describe("Already formatted, e.g. +8% or -0.1 pt"),
  tone: tone.optional(),
});

const shown = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stats"),
    tiles: z.array(tile).min(1).max(6),
  }),
  z.object({
    kind: z.literal("chart"),
    chart: z.enum(["line", "bar", "area"]),
    x: z.array(z.string()).min(2).max(60).describe("One label per point, shared by every series"),
    series: z
      .array(z.object({ name: z.string(), values: z.array(z.number()) }))
      .min(1)
      .max(4)
      .describe("Each series has one value per x label"),
    unit: z.string().optional().describe('Appended to values, e.g. "%" or " visitors"'),
  }),
  z.object({
    kind: z.literal("table"),
    columns: z
      .array(z.object({ key: z.string(), label: z.string(), align: z.enum(["left", "right"]).optional() }))
      .min(1)
      .max(8)
      .describe("Right-align numbers"),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(50),
    total: z.number().int().optional().describe("The full row count when rows is a cut"),
  }),
  z.object({
    kind: z.literal("checklist"),
    items: z
      .array(
        z.object({
          text: z.string(),
          state: z.enum(["done", "waiting", "failed", "skipped"]),
          detail: z.string().optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
  z.object({
    kind: z.literal("brief"),
    name: z.string().describe("The person or company"),
    subtitle: z.string().optional(),
    points: z.array(z.string()).max(6).optional(),
    facts: z.array(z.object({ label: z.string(), value: z.string() })).max(8).optional(),
    tiles: z.array(tile).max(4).optional(),
  }),
  z.object({
    kind: z.literal("link"),
    url: z.string().url(),
    title: z.string().optional(),
    site: z.string().optional(),
    description: z.string().optional(),
  }),
]);

export default defineTool({
  description:
    "Show the person a card in KYBER Studio, the phone app or Buzz: a few key numbers (stats), a trend (chart), rows (table), progress (checklist), a short profile of a person or company (brief), or one link. Use it when a reply is mainly numbers, a comparison or a status, after you have the data. Keep your written reply to a sentence or two that stands on its own, because some channels never show cards. Don't repeat the card's contents in the reply.",
  inputSchema: z.object({
    title: z.string().max(120).describe("Short title, e.g. Website traffic, last 7 days"),
    source: z.string().max(40).optional().describe("Where the data came from, e.g. PostHog or Gmail"),
    show: shown,
  }),
  label: {
    start: ({ title }) => `Showing ${title}`,
  },
  async execute({ title, source, show }) {
    const fields = { title, ...(source ? { source } : {}) };
    const made = (() => {
      switch (show.kind) {
        case "stats":
          return card("stats", { tiles: show.tiles }, fields);
        case "chart":
          return card("chart", { kind: show.chart, x: show.x, series: show.series, ...(show.unit ? { unit: show.unit } : {}) }, fields);
        case "table":
          return card("table", { columns: show.columns, rows: show.rows, ...(show.total ? { total: show.total } : {}) }, fields);
        case "checklist":
          return card("checklist", { items: show.items }, fields);
        case "brief": {
          const { kind: _kind, ...data } = show;
          return card("brief", data, fields);
        }
        case "link": {
          const { kind: _kind, ...data } = show;
          return card("link", data, fields);
        }
      }
    })();
    // The same reader the apps use: what it drops, they would drop too.
    const checked = parseCard(made);
    if (!checked) return { shown: false, error: "That card could not be drawn. Put the content in your reply instead." };
    // The card's plain text stays in what the model reads, for channels that draw no cards.
    return withCards({ shown: true, text: checked.text }, checked);
  },
  toModelOutput: (output) => forModel(output),
});
