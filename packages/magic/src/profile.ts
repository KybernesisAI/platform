import { isTimeZone, parseClock } from "./time.js";
import { MOMENT_KINDS, type Boldness, type MomentKind, type Profile } from "./types.js";

/**
 * Off until the person turns it on, and quiet by default once they do: a few
 * interruptions a day, nothing overnight, offers rather than actions.
 */
export const DEFAULT_PROFILE: Profile = {
  enabled: false,
  timeZone: null,
  quietHours: { start: "22:00", end: "07:00" },
  briefAt: "07:30",
  wrapAt: null,
  dailyBudget: 6,
  meetingLeadMinutes: 15,
  leaveBufferMinutes: 10,
  travelFallbackMinutes: 30,
  travelMode: "DRIVE",
  replyAfterHours: 4,
  replyLookbackDays: 3,
  vips: [],
  places: {},
  workHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
  boldness: "suggest",
  kinds: {},
};

/** Per-kind cooldowns, so one kind cannot crowd out the rest. */
export const DEFAULT_COOLDOWN_MINUTES: Record<MomentKind, number> = {
  brief: 0,
  wrap: 0,
  meeting_prep: 0,
  leave: 0,
  conflict: 60,
  reply_owed: 120,
  vip_mail: 15,
  reminder: 0,
};

const BOLDNESS: readonly Boldness[] = ["tell", "suggest", "draft"];
const TRAVEL_MODES = ["DRIVE", "TRANSIT", "WALK", "BICYCLE", "TWO_WHEELER"] as const;

function clock(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" && parseClock(value) !== undefined ? value.trim() : fallback;
}

function count(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** A place set to text, cleared with null, or left as it was. */
function place(key: "home" | "office", value: unknown, fallback: string | undefined): Partial<Record<typeof key, string>> {
  if (typeof value === "string" && value.trim()) return { [key]: value.trim().slice(0, 300) };
  if (value === null || value === "" || !fallback) return {};
  return { [key]: fallback };
}

/**
 * A complete profile from whatever is on disk or in a tool call.
 *
 * Unknown keys are dropped and bad values fall back to the default, so a hand
 * edit or an older file can never stop the tick.
 */
export function normalizeProfile(input: unknown, base: Profile = DEFAULT_PROFILE): Profile {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const quiet = raw.quietHours ?? {};
  const work = raw.workHours ?? {};
  const places = raw.places ?? {};
  const kinds: Profile["kinds"] = {};
  for (const kind of MOMENT_KINDS) {
    const k = raw.kinds?.[kind] ?? base.kinds[kind];
    if (!k || typeof k !== "object") continue;
    kinds[kind] = {
      ...(typeof k.enabled === "boolean" ? { enabled: k.enabled } : {}),
      ...(k.cooldownMinutes !== undefined ? { cooldownMinutes: count(k.cooldownMinutes, 0, 0, 7 * 24 * 60) } : {}),
    };
  }
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    timeZone: isTimeZone(raw.timeZone) ? raw.timeZone : raw.timeZone === null ? null : base.timeZone,
    ...(typeof raw.name === "string" && raw.name.trim()
      ? { name: raw.name.trim().slice(0, 80) }
      : base.name
        ? { name: base.name }
        : {}),
    quietHours: {
      start: clock(quiet.start, base.quietHours.start) ?? base.quietHours.start,
      end: clock(quiet.end, base.quietHours.end) ?? base.quietHours.end,
    },
    briefAt: "briefAt" in raw ? clock(raw.briefAt, base.briefAt) : base.briefAt,
    wrapAt: "wrapAt" in raw ? clock(raw.wrapAt, base.wrapAt) : base.wrapAt,
    dailyBudget: count(raw.dailyBudget, base.dailyBudget, 0, 50),
    meetingLeadMinutes: count(raw.meetingLeadMinutes, base.meetingLeadMinutes, 5, 120),
    leaveBufferMinutes: count(raw.leaveBufferMinutes, base.leaveBufferMinutes, 0, 120),
    travelFallbackMinutes: count(raw.travelFallbackMinutes, base.travelFallbackMinutes, 0, 600),
    travelMode: TRAVEL_MODES.includes(raw.travelMode) ? raw.travelMode : base.travelMode,
    replyAfterHours: count(raw.replyAfterHours, base.replyAfterHours, 1, 168),
    replyLookbackDays: count(raw.replyLookbackDays, base.replyLookbackDays, 1, 14),
    vips: Array.isArray(raw.vips)
      ? [...new Set(raw.vips.filter((v: unknown) => typeof v === "string" && v.trim()).map((v: string) => v.trim().toLowerCase()))].slice(0, 100) as string[]
      : base.vips,
    places: {
      ...place("home", places.home, base.places.home),
      ...place("office", places.office, base.places.office),
    },
    workHours: {
      start: clock(work.start, base.workHours.start) ?? base.workHours.start,
      end: clock(work.end, base.workHours.end) ?? base.workHours.end,
      days: Array.isArray(work.days)
        ? [...new Set(work.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))] as number[]
        : base.workHours.days,
    },
    boldness: BOLDNESS.includes(raw.boldness) ? raw.boldness : base.boldness,
    kinds,
  };
}

/** Apply a partial change from the person on top of what they already have. */
export function updateProfile(current: Profile, change: Record<string, unknown>): Profile {
  const merged: Record<string, unknown> = { ...current, ...change };
  for (const key of ["quietHours", "workHours", "places"] as const) {
    if (change[key] && typeof change[key] === "object") {
      merged[key] = { ...current[key], ...(change[key] as object) };
    }
  }
  if (change.kinds && typeof change.kinds === "object") {
    const kinds: Record<string, unknown> = { ...current.kinds };
    for (const [k, v] of Object.entries(change.kinds as Record<string, object>)) {
      kinds[k] = { ...(current.kinds[k as MomentKind] ?? {}), ...v };
    }
    merged.kinds = kinds;
  }
  return normalizeProfile(merged, current);
}

export function kindEnabled(profile: Profile, kind: MomentKind): boolean {
  if (kind === "brief" && !profile.briefAt) return false;
  if (kind === "wrap" && !profile.wrapAt) return false;
  return profile.kinds[kind]?.enabled !== false;
}

export function cooldownMinutes(profile: Profile, kind: MomentKind): number {
  return profile.kinds[kind]?.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES[kind];
}

/** Why magic cannot run for this person yet, or undefined when it can. */
export function notReady(profile: Profile): string | undefined {
  if (!profile.enabled) return "Magic is off.";
  if (!profile.timeZone) return "Magic needs the person's time zone before it can run.";
  return undefined;
}
