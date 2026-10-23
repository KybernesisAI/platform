import type { CalendarEvent, EmailMessage } from "./types.js";

/**
 * Tolerant readers for connector results.
 *
 * Connector tools wrap the provider's answer in their own envelope, and the
 * envelope has changed shape before without notice. So these look for the
 * provider's own objects wherever they sit, and skip anything they cannot
 * read rather than throwing: one odd event must never cost the whole day.
 */

type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Every array of objects in `value` that passes `test`, depth-first. */
function findArrays(value: unknown, test: (item: Obj) => boolean, depth = 0): Obj[][] {
  if (depth > 6 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const objs = value.filter(isObj);
    if (objs.length && objs.some(test)) return [objs];
    return value.flatMap((v) => findArrays(v, test, depth + 1));
  }
  return Object.values(value).flatMap((v) => findArrays(v, test, depth + 1));
}

function unwrap(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function iso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : /^\d{10,13}$/.test(String(value)) ? Number(value) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "Ana Ruiz <ana@x.com>" → { email: "ana@x.com", name: "Ana Ruiz" }. */
export function parseAddress(value: unknown): { email: string; name?: string } | undefined {
  if (isObj(value)) {
    const email = String(value.email ?? value.address ?? "").trim().toLowerCase();
    const name = value.name ?? value.displayName;
    return email ? { email, ...(name ? { name: String(name) } : {}) } : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (m) return { email: m[2]!.trim().toLowerCase(), ...(m[1]!.trim() ? { name: m[1]!.trim() } : {}) };
  const bare = /[^\s<>,;]+@[^\s<>,;]+/.exec(value)?.[0];
  return bare ? { email: bare.toLowerCase() } : undefined;
}

function eventTime(value: unknown): { at?: string; allDay: boolean } {
  if (isObj(value)) {
    if (value.dateTime) return { at: iso(value.dateTime), allDay: false };
    if (value.date) return { at: iso(`${value.date}T00:00:00Z`), allDay: true };
    return { allDay: false };
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { at: iso(`${value}T00:00:00Z`), allDay: true };
  return { at: iso(value), allDay: false };
}

const looksLikeEvent = (o: Obj) => "start" in o && ("end" in o || "summary" in o || "id" in o);

/** Calendar events from a connector result, cancelled ones removed. */
export function parseCalendarEvents(result: unknown): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const seen = new Set<string>();
  for (const list of findArrays(unwrap(result), looksLikeEvent)) {
    for (const raw of list) {
      if (!looksLikeEvent(raw) || raw.status === "cancelled") continue;
      const start = eventTime(raw.start);
      const end = eventTime(raw.end);
      if (!start.at) continue;
      const id = String(raw.id ?? raw.iCalUID ?? `${raw.summary ?? ""}@${start.at}`);
      if (seen.has(`${id}@${start.at}`)) continue;
      seen.add(`${id}@${start.at}`);
      const attendees = (Array.isArray(raw.attendees) ? raw.attendees : [])
        .filter(isObj)
        .map((a: Obj) => ({
          email: String(a.email ?? "").toLowerCase(),
          ...(a.displayName ? { name: String(a.displayName) } : {}),
          ...(a.self ? { self: true } : {}),
          ...(a.responseStatus ? { response: String(a.responseStatus) } : {}),
        }))
        .filter((a: { email: string }) => a.email);
      const self = attendees.find((a: { self?: boolean }) => a.self);
      out.push({
        id,
        title: String(raw.summary ?? raw.title ?? "(no title)").slice(0, 200),
        start: start.at,
        end: end.at ?? start.at,
        allDay: start.allDay,
        ...(raw.location ? { location: String(raw.location).slice(0, 300) } : {}),
        ...(raw.description ? { description: String(raw.description).slice(0, 500) } : {}),
        attendees,
        ...(self?.response ? { response: self.response } : {}),
        ...(raw.transparency === "transparent" ? { free: true } : {}),
        ...(raw.hangoutLink || raw.htmlLink ? { link: String(raw.hangoutLink ?? raw.htmlLink) } : {}),
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function header(raw: Obj, name: string): string | undefined {
  const headers = raw.payload?.headers ?? raw.headers;
  if (!Array.isArray(headers)) return undefined;
  const h = headers.find((x: Obj) => String(x?.name ?? "").toLowerCase() === name);
  return h?.value ? String(h.value) : undefined;
}

const looksLikeEmail = (o: Obj) =>
  ("threadId" in o || "thread_id" in o) && ("messageId" in o || "id" in o || "message_id" in o);

/** Email messages from a connector result, newest first. */
export function parseEmails(result: unknown): EmailMessage[] {
  const out: EmailMessage[] = [];
  const seen = new Set<string>();
  for (const list of findArrays(unwrap(result), looksLikeEmail)) {
    for (const raw of list) {
      if (!looksLikeEmail(raw)) continue;
      const id = String(raw.messageId ?? raw.message_id ?? raw.id);
      if (seen.has(id)) continue;
      const at = iso(raw.messageTimestamp ?? raw.internalDate ?? raw.date ?? header(raw, "date"));
      const from = parseAddress(raw.sender ?? raw.from ?? header(raw, "from"));
      if (!at || !from) continue;
      seen.add(id);
      const labels = raw.labelIds ?? raw.label_ids ?? raw.labels;
      out.push({
        id,
        threadId: String(raw.threadId ?? raw.thread_id),
        from: from.email,
        ...(from.name ? { fromName: from.name } : {}),
        ...(raw.to || header(raw, "to") ? { to: String(raw.to ?? header(raw, "to")).slice(0, 300) } : {}),
        subject: String(raw.subject ?? raw.preview?.subject ?? header(raw, "subject") ?? "(no subject)").slice(0, 200),
        ...(raw.preview?.body || raw.snippet ? { snippet: String(raw.preview?.body ?? raw.snippet).slice(0, 300) } : {}),
        at,
        labels: Array.isArray(labels) ? labels.map(String) : [],
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
