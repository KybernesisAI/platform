import { isKnownCard, type Card, type ChartData, type KnownCard, type StatTile, type TableData } from "./types.js";

/**
 * A card as text, for a channel that cannot draw one.
 *
 * Buzz, iMessage and Slack get the same card as a few plain lines: a title, the
 * substance, and a link where there is one. "slack" only changes emphasis to
 * Slack's own `*bold*`; everything else is the same text.
 *
 * A card's own `text` wins when the maker wrote one. These rules are for the
 * cards that arrive without it, so the fallback is never left to the model.
 */
export type TextDialect = "plain" | "slack";

const BARS = "▁▂▃▄▅▆▇█";

/** A row of block characters tracing the values, e.g. ▂▃▁▅█▄▆. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi === lo) return BARS[3]!.repeat(values.length);
  return values.map((v) => BARS[Math.round(((v - lo) / (hi - lo)) * (BARS.length - 1))]!).join("");
}

/** Minor units as money, e.g. 255600 USD → "$2,556.00". */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

const tileText = (t: StatTile): string => `${t.label} ${t.value}${t.change ? ` (${t.change})` : ""}`;

/** "30" and "emails" → "30 emails"; "%" and "k" stay attached. */
export function withUnit(value: string, unit?: string): string {
  if (!unit) return value;
  return /^[A-Za-z]/.test(unit) ? `${value} ${unit}` : `${value}${unit}`;
}

function chartText(d: ChartData): string[] {
  return d.series.map((s) => {
    const last = s.values[s.values.length - 1];
    const name = s.name || "Values";
    const range = d.x.length > 1 ? `, ${d.x[0]} to ${d.x[d.x.length - 1]}` : "";
    return `${name}${range}: ${sparkline(s.values)} latest ${withUnit(String(last), d.unit)}`;
  });
}

function tableText(d: TableData, rows = 10): string[] {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const head = d.columns.map((c) => c.label).join(" | ");
  const body = d.rows.slice(0, rows).map((r) => d.columns.map((c) => cell(r[c.key])).join(" | "));
  const more = (d.total ?? d.rows.length) - Math.min(rows, d.rows.length);
  return [head, ...body, ...(more > 0 ? [`…and ${more} more rows`] : [])];
}

function body(card: KnownCard): string[] {
  switch (card.card) {
    case "stats":
      return [card.data.tiles.map(tileText).join(" · ")];
    case "chart":
      return chartText(card.data);
    case "table":
      return tableText(card.data);
    case "checklist":
      return card.data.items.map((i) => `${i.state === "done" ? "✓" : i.state === "failed" ? "✗" : i.state === "skipped" ? "–" : "○"} ${i.text}`);
    case "brief": {
      const d = card.data;
      return [
        ...(d.subtitle ? [d.subtitle] : []),
        ...(d.points ?? []).map((p) => `• ${p}`),
        ...(d.facts?.length ? [d.facts.map((f) => `${f.label}: ${f.value}`).join(" · ")] : []),
        ...(d.tiles?.length ? [d.tiles.map(tileText).join(" · ")] : []),
      ];
    }
    case "link":
      return [...(card.data.description ? [card.data.description] : []), card.data.url];
    case "screenshot":
      return [card.data.caption ?? "A screenshot from the agent's computer.", ...(card.data.site ? [card.data.site] : [])];
    case "file":
      return [card.data.url];
    case "artifact":
      return [card.data.url ?? "Open it in KYBER Studio."];
    case "pull-request": {
      const d = card.data;
      const lines = [d.summary, d.additions !== undefined || d.deletions !== undefined ? `+${d.additions ?? 0} −${d.deletions ?? 0}` : undefined];
      const checks = d.checks?.length ? d.checks.map((c) => `${c.state === "passed" ? "✓" : c.state === "failed" ? "✗" : "…"} ${c.name}`).join("  ") : undefined;
      return [...lines, checks, d.url].filter((l): l is string => Boolean(l));
    }
    case "receipt": {
      const d = card.data;
      return [`Paid ${money(d.amount, d.currency)}${d.orderId ? ` · order ${d.orderId}` : ""}`, ...(d.note ? [d.note] : []), ...(d.file ? [d.file.url] : [])];
    }
    case "remembered":
      return [`Noted: ${card.data.fact}`];
    case "routine": {
      const d = card.data;
      return [`${d.schedule}${d.posts?.length ? ` · posts to ${d.posts.join(", ")}` : ""}`];
    }
    case "approval": {
      const d = card.data;
      const short = (t: string) => (t.length > 280 ? `${t.slice(0, 279)}…` : t);
      return [
        ...(d.to?.length ? [`To: ${d.to.join(", ")}`] : []),
        ...(d.cc?.length ? [`Cc: ${d.cc.join(", ")}`] : []),
        ...(d.channel ? [`In: ${d.channel}`] : []),
        ...(d.subject ? [d.kind === "email" ? `Subject: ${d.subject}` : d.subject] : []),
        ...(d.when ? [`When: ${d.when}${d.until ? ` to ${d.until}` : ""}`] : []),
        ...(d.where ? [`Where: ${d.where}`] : []),
        ...(d.people?.length ? [`With: ${d.people.join(", ")}`] : []),
        ...(d.body ? [short(d.body)] : []),
        ...(d.fields ?? []).map((f) => `${f.label}: ${f.value}`),
      ];
    }
    case "form":
      return card.data.fields.map((f, i) => `${i + 1}. ${f.label}${f.kind === "choice" && f.options ? ` (${f.options.join(" / ")})` : ""}`);
  }
}

/** The title a card shows, falling back to what its data names. */
export function cardTitle(card: Card): string | undefined {
  if (card.title) return card.title;
  if (!isKnownCard(card)) return undefined;
  switch (card.card) {
    case "brief":
      return card.data.name;
    case "link":
      return card.data.title ?? card.data.site;
    case "file":
      return card.data.name;
    case "pull-request":
      return `${card.data.title} (#${card.data.number}, ${card.data.repo})`;
    case "receipt":
      return `Order placed · ${card.data.merchant}`;
    case "routine":
      return `Routine: ${card.data.name}`;
    case "remembered":
      return undefined;
    case "approval":
      return card.data.service ? `${card.data.action} · ${card.data.service}` : card.data.action;
    default:
      return undefined;
  }
}

/** The card as text. The maker's own `text` is used when it wrote one. */
export function cardText(card: Card, dialect: TextDialect = "plain"): string {
  if (card.text) return card.text;
  if (!isKnownCard(card)) return "";
  const title = cardTitle(card);
  const titled = title ? [dialect === "slack" ? `*${title}*${card.source ? ` (${card.source})` : ""}` : `${title}${card.source ? ` (${card.source})` : ""}`] : [];
  return [...titled, ...body(card)].join("\n");
}
