import {
  CARD_VERSION,
  KNOWN_CARD_TYPES,
  type Card,
  type CardAction,
  type CardDataByType,
  type ApprovalKind,
  type ChecklistState,
  type CheckState,
  type FormField,
  type FormFieldKind,
  type KnownCardType,
  type StatTile,
  type TableCell,
  type Tone,
} from "./types.js";

/**
 * Reading a card someone else wrote.
 *
 * A card arrives from a model or a tool through a stream the client did not
 * produce, so nothing here trusts its shape. The rule is to keep what is
 * well-formed and drop what is not: a table with one bad row still shows the
 * good rows, but a card whose required fields are missing is not a card at
 * all. Links are the one place a bad value is dangerous rather than ugly, so
 * only web addresses and paths on the agent's own address survive.
 */

/** Limits that keep a card a card. Past them, the content belongs in an artifact. */
export const LIMITS = {
  text: 4000,
  string: 600,
  tiles: 8,
  series: 4,
  points: 120,
  columns: 12,
  rows: 50,
  items: 50,
  actions: 4,
  diffLines: 24,
} as const;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, max: number = LIMITS.string): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function list(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

/**
 * A link a client may open: http(s), or a path on the agent's own address.
 *
 * Anything else — `javascript:`, `data:`, `file:`, a protocol-relative `//host`
 * — is dropped, because a card is drawn inside an app that holds the person's
 * credentials.
 */
export function safeUrl(v: unknown): string | undefined {
  const s = str(v, 2000);
  if (!s) return undefined;
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const tone = (v: unknown): Tone | undefined => (v === "good" || v === "bad" || v === "neutral" ? v : undefined);

function tiles(v: unknown): StatTile[] {
  const out: StatTile[] = [];
  for (const t of list(v, LIMITS.tiles)) {
    if (!isObj(t)) continue;
    const label = str(t.label);
    const value = str(t.value);
    if (!label || !value) continue;
    out.push({ label, value, change: str(t.change), tone: tone(t.tone) });
  }
  return out;
}

function actions(v: unknown): CardAction[] | undefined {
  const out: CardAction[] = [];
  let primary = false;
  for (const a of list(v, LIMITS.actions)) {
    if (!isObj(a)) continue;
    const label = str(a.label, 60);
    if (!label) continue;
    const url = safeUrl(a.url);
    const artifact = str(a.artifact, 120);
    const say = str(a.say, 500);
    const action: CardAction = url ? { label, url } : artifact ? { label, artifact } : say ? { label, say } : { label };
    if (!action.url && !action.artifact && !action.say) continue;
    if (a.primary === true && !primary) {
      action.primary = true;
      primary = true;
    }
    out.push(action);
  }
  return out.length ? out : undefined;
}

const CHECK: readonly ChecklistState[] = ["done", "waiting", "failed", "skipped"];
const APPROVAL_KINDS: readonly ApprovalKind[] = ["email", "event", "message", "action"];
const FIELD_KINDS: readonly FormFieldKind[] = ["text", "long", "number", "date", "email", "choice"];
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

function strings(v: unknown, max: number, len = 200): string[] | undefined {
  const out = list(v, max).flatMap((s) => str(s, len) ?? []);
  return out.length ? out : undefined;
}

/** Each type's data, or null when the card cannot be drawn as that type. */
const DATA: { [T in KnownCardType]: (d: Obj) => CardDataByType[T] | null } = {
  stats(d) {
    const t = tiles(d.tiles);
    return t.length ? { tiles: t } : null;
  },
  chart(d) {
    const kind = d.kind === "bar" || d.kind === "area" ? d.kind : "line";
    const x = list(d.x, LIMITS.points).map((v) => str(v, 40) ?? "");
    const series = list(d.series, LIMITS.series).flatMap((s) => {
      if (!isObj(s)) return [];
      const values = list(s.values, LIMITS.points).map(num);
      if (values.length === 0 || values.some((n) => n === undefined)) return [];
      return [{ name: str(s.name, 60) ?? "", values: values as number[] }];
    });
    if (!series.length) return null;
    const points = Math.max(...series.map((s) => s.values.length));
    // Labels and values must line up, or the chart lies about which value is which.
    const labels = x.length === points ? x : Array.from({ length: points }, (_, i) => x[i] ?? "");
    return { kind, x: labels, series, unit: str(d.unit, 20) };
  },
  table(d) {
    const columns = list(d.columns, LIMITS.columns).flatMap((c) => {
      if (!isObj(c)) return [];
      const key = str(c.key, 60);
      if (!key) return [];
      return [{ key, label: str(c.label, 60) ?? key, align: c.align === "right" ? ("right" as const) : undefined }];
    });
    if (!columns.length || !Array.isArray(d.rows)) return null;
    const all = d.rows.filter(isObj);
    const rows = all.slice(0, LIMITS.rows).map((r) => {
      const row: Record<string, TableCell> = {};
      for (const c of columns) {
        const v = r[c.key];
        row[c.key] = typeof v === "number" && Number.isFinite(v) ? v : (str(v, 200) ?? null);
      }
      return row;
    });
    const total = Math.max(num(d.total) ?? 0, all.length);
    return { columns, rows, total: total > rows.length ? total : undefined };
  },
  checklist(d) {
    const items = list(d.items, LIMITS.items).flatMap((i) => {
      if (!isObj(i)) return [];
      const text = str(i.text);
      if (!text) return [];
      const state = CHECK.includes(i.state as ChecklistState) ? (i.state as ChecklistState) : "waiting";
      return [{ text, state, detail: str(i.detail) }];
    });
    return items.length ? { items } : null;
  },
  brief(d) {
    const name = str(d.name, 120);
    if (!name) return null;
    const facts = list(d.facts, 8).flatMap((f) => {
      if (!isObj(f)) return [];
      const label = str(f.label, 40);
      const value = str(f.value);
      return label && value ? [{ label, value }] : [];
    });
    const points = list(d.points, 8).flatMap((p) => str(p) ?? []);
    const t = tiles(d.tiles);
    return {
      name,
      subtitle: str(d.subtitle),
      initial: str(d.initial, 2),
      points: points.length ? points : undefined,
      facts: facts.length ? facts : undefined,
      tiles: t.length ? t : undefined,
    };
  },
  link(d) {
    const url = safeUrl(d.url);
    if (!url) return null;
    return { url, title: str(d.title, 200), site: str(d.site, 120), description: str(d.description), image: safeUrl(d.image) };
  },
  screenshot(d) {
    const image = safeUrl(d.image);
    if (!image) return null;
    return { image, caption: str(d.caption), site: str(d.site, 200), takenAt: str(d.takenAt, 40), width: num(d.width), height: num(d.height) };
  },
  file(d) {
    const url = safeUrl(d.url);
    const name = str(d.name, 200);
    if (!url || !name) return null;
    return { url, name, size: num(d.size), mediaType: str(d.mediaType, 100) };
  },
  artifact(d) {
    const artifactId = str(d.artifactId, 120);
    if (!artifactId) return null;
    return {
      artifactId,
      version: num(d.version),
      display: d.display === "inline" ? "inline" : "document",
      format: d.format === "markdown" ? "markdown" : d.format === "html" ? "html" : undefined,
      updatedAt: str(d.updatedAt, 40),
      url: safeUrl(d.url),
    };
  },
  "pull-request"(d) {
    const repo = str(d.repo, 120);
    const title = str(d.title, 200);
    const url = safeUrl(d.url);
    const number = num(d.number);
    if (!repo || !title || !url || number === undefined) return null;
    const checks = list(d.checks, 10).flatMap((c) => {
      if (!isObj(c)) return [];
      const name = str(c.name, 80);
      const state: CheckState | undefined = c.state === "passed" || c.state === "failed" || c.state === "running" ? c.state : undefined;
      return name && state ? [{ name, state, detail: str(c.detail, 120) }] : [];
    });
    let diff: { file: string; lines: string[] } | undefined;
    if (isObj(d.diff)) {
      const file = str(d.diff.file, 200);
      const lines = list(d.diff.lines, LIMITS.diffLines).flatMap((l) => (typeof l === "string" ? [l.slice(0, 300)] : []));
      if (file && lines.length) diff = { file, lines };
    }
    return {
      repo,
      number,
      title,
      url,
      summary: str(d.summary),
      additions: num(d.additions),
      deletions: num(d.deletions),
      checks: checks.length ? checks : undefined,
      diff,
      preview: safeUrl(d.preview),
      reviewer: str(d.reviewer, 80),
    };
  },
  receipt(d) {
    const merchant = str(d.merchant, 120);
    const amount = num(d.amount);
    const currency = str(d.currency, 3);
    if (!merchant || amount === undefined || !currency) return null;
    let file: { url: string; name: string } | undefined;
    if (isObj(d.file)) {
      const url = safeUrl(d.file.url);
      const name = str(d.file.name, 200);
      if (url && name) file = { url, name };
    }
    return { merchant, amount, currency: currency.toUpperCase(), orderId: str(d.orderId, 80), file, note: str(d.note) };
  },
  remembered(d) {
    const fact = str(d.fact, 1000);
    return fact ? { fact, memoryId: str(d.memoryId, 120) } : null;
  },
  routine(d) {
    const name = str(d.name, 120);
    const schedule = str(d.schedule, 200);
    if (!name || !schedule) return null;
    const posts = list(d.posts, 6).flatMap((p) => str(p, 80) ?? []);
    const cron = str(d.cron, 100);
    const offset = num(d.offset);
    return {
      name,
      schedule,
      nextRun: str(d.nextRun, 40),
      posts: posts.length ? posts : undefined,
      cron: cron && cron.split(/\s+/).length === 5 ? cron : undefined,
      offset: offset !== undefined && Math.abs(offset) <= 16 * 60 ? Math.round(offset) : undefined,
    };
  },
  approval(d) {
    const kind = APPROVAL_KINDS.includes(d.kind as ApprovalKind) ? (d.kind as ApprovalKind) : "action";
    const tool = str(d.tool, 200);
    const action = str(d.action, 80);
    if (!tool || !action) return null;
    const fields = list(d.fields, 10).flatMap((f) => {
      if (!isObj(f)) return [];
      const label = str(f.label, 60);
      const value = str(f.value);
      return label && value ? [{ label, value }] : [];
    });
    return {
      kind,
      tool,
      action,
      service: str(d.service, 60),
      to: strings(d.to, 20),
      cc: strings(d.cc, 20),
      subject: str(d.subject, 300),
      body: str(d.body, LIMITS.text),
      when: str(d.when, 80),
      until: str(d.until, 80),
      where: str(d.where, 200),
      people: strings(d.people, 30),
      channel: str(d.channel, 120),
      fields: fields.length ? fields : undefined,
    };
  },
  form(d) {
    const seen = new Set<string>();
    const fields = list(d.fields, 12).flatMap((f): FormField[] => {
      if (!isObj(f)) return [];
      const id = str(f.id, 40);
      const label = str(f.label, 120);
      if (!id || !label || !FIELD_ID.test(id) || seen.has(id)) return [];
      seen.add(id);
      let kind = FIELD_KINDS.includes(f.kind as FormFieldKind) ? (f.kind as FormFieldKind) : "text";
      const options = strings(f.options, 20, 120);
      // A choice with nothing to choose is a text box.
      if (kind === "choice" && !options) kind = "text";
      return [
        {
          id,
          label,
          kind,
          options: kind === "choice" ? options : undefined,
          required: f.required === true ? true : undefined,
          placeholder: str(f.placeholder, 120),
          value: str(f.value, 1000),
        },
      ];
    });
    return fields.length ? { fields, submit: str(d.submit, 40) } : null;
  },
};

/** Drop keys whose value is undefined, all the way down, so a parsed card compares and serialises the way it was written. */
function compact<T>(v: T): T {
  if (Array.isArray(v)) {
    for (const item of v) compact(item);
  } else if (isObj(v)) {
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) delete v[k];
      else compact(v[k]);
    }
  }
  return v;
}

/**
 * A card, or null when the value is not one.
 *
 * A known type with data that cannot be drawn is not a card, unless it carries
 * `text`: then it degrades to an unknown card that shows the text, because the
 * maker said something worth showing.
 */
export function parseCard(value: unknown): Card | null {
  if (!isObj(value) || value.kyb !== CARD_VERSION) return null;
  const type = str(value.card, 40);
  if (!type) return null;
  const envelope = {
    kyb: CARD_VERSION,
    id: str(value.id, 120),
    title: str(value.title, 200),
    source: str(value.source, 60),
    actions: actions(value.actions),
    text: str(value.text, LIMITS.text),
  };
  if ((KNOWN_CARD_TYPES as readonly string[]).includes(type)) {
    const reader = DATA[type as KnownCardType] as (d: Obj) => unknown;
    const data = isObj(value.data) ? reader(value.data) : null;
    if (data) return compact({ ...envelope, card: type, data: compact(data as Obj) }) as Card;
    return envelope.text ? (compact({ ...envelope, card: "unknown" }) as Card) : null;
  }
  // A type from a newer version: keep the envelope so the client can show the text.
  return envelope.text ? (compact({ ...envelope, card: type }) as Card) : null;
}

/**
 * The cards a tool handed back, from its output on an `action.result` event.
 *
 * A tool puts them under `kyb`: one card or a list. The output may also arrive
 * as a JSON string, which is how some tools and older eve versions return
 * objects; a string that is not JSON has no cards.
 */
export function cardsFromOutput(output: unknown): Card[] {
  let value = output;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t.startsWith("{")) return [];
    try {
      value = JSON.parse(t);
    } catch {
      return [];
    }
  }
  if (!isObj(value) || value.kyb === undefined) return [];
  const raw = Array.isArray(value.kyb) ? value.kyb.slice(0, 6) : [value.kyb];
  return raw.flatMap((c) => parseCard(c) ?? []);
}
