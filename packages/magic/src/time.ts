/**
 * Local time for one person, from an IANA zone, with nothing but Intl.
 *
 * Schedules fire in the host's clock (UTC on our hosts), and people live in
 * their own. Every "is it 7:30 yet" and "is it quiet hours" question goes
 * through here so the two are never confused.
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when the runtime knows this zone. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

/** The person's calendar date, YYYY-MM-DD. */
export function localDate(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes since local midnight. */
export function localMinutes(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** "07:30" → 450. Returns undefined for anything that is not HH:MM. */
export function parseClock(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/** True when `minutes` falls in [start, end), wrapping past midnight. */
export function inWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** "Thu 23 Oct, 07:31" in the person's zone, for the packet. */
export function describeLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** "14:05" in the person's zone. */
export function clockIn(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
