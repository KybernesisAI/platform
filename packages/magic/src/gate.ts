import { cooldownMinutes, kindEnabled } from "./profile.js";
import { DAY, HOUR, inWindow, localDate, localMinutes, MINUTE, parseClock } from "./time.js";
import type { MagicState, Moment, MomentKind, Profile } from "./types.js";

/**
 * The gate: whether a moment is said now, saved for the next digest, held for
 * a later tick, or let go. Silence is the default. A moment has to earn its
 * interruption against quiet hours, the person being busy, the kind's
 * cooldown and the day's budget.
 */

export interface GateInput {
  profile: Profile;
  state: MagicState;
  now: Date;
  /** The person is in a meeting right now. */
  inMeeting?: boolean;
}

export interface GateResult {
  /** Said in this tick, in one message. */
  deliver: Moment[];
  /** Saved for the next brief or wrap. */
  queued: Moment[];
  /** Not yet: asked again on a later tick. */
  held: Moment[];
  /** Never: expired or switched off. */
  dropped: Moment[];
}

/** Scheduled by the person, so quiet hours and busy time do not apply. */
const ASKED_FOR: readonly MomentKind[] = ["brief", "wrap", "reminder"];
/** Still worth an interruption in the middle of a meeting. */
const THROUGH_MEETINGS: readonly MomentKind[] = ["brief", "wrap", "reminder", "leave"];

/** The person wrote to the agent this recently: do not talk over them. */
export const CONVERSATION_HOLD_MS = 3 * MINUTE;

const RANK: Record<Moment["urgency"], number> = { now: 0, soon: 1, digest: 2 };

export function isQuietHours(profile: Profile, now: Date): boolean {
  if (!profile.timeZone) return false;
  const start = parseClock(profile.quietHours.start);
  const end = parseClock(profile.quietHours.end);
  if (start === undefined || end === undefined) return false;
  return inWindow(localMinutes(now, profile.timeZone), start, end);
}

/** True when the person is mid-conversation with the agent, magic's own turns aside. */
export function inConversation(state: MagicState, now: Date): boolean {
  if (!state.lastActiveAt) return false;
  return now.getTime() - new Date(state.lastActiveAt).getTime() < CONVERSATION_HOLD_MS;
}

export function sentToday(state: MagicState, profile: Profile, now: Date): number {
  return profile.timeZone ? state.sentByDay[localDate(now, profile.timeZone)] ?? 0 : 0;
}

export function gate(moments: Moment[], input: GateInput): GateResult {
  const { profile, state, now } = input;
  const result: GateResult = { deliver: [], queued: [], held: [], dropped: [] };
  const at = now.toISOString();
  const known = new Set(state.ledger.map((e) => e.key));
  const seen = new Set<string>();
  const quiet = isQuietHours(profile, now);
  const talking = inConversation(state, now);
  const overBudget = sentToday(state, profile, now) >= profile.dailyBudget;

  const ordered = [...moments].sort((a, b) => RANK[a.urgency] - RANK[b.urgency] || a.dueAt.localeCompare(b.dueAt));
  for (const m of ordered) {
    if (known.has(m.key) || seen.has(m.key)) continue;
    seen.add(m.key);
    const urgent = m.urgent === true;
    const askedFor = ASKED_FOR.includes(m.kind);

    if (m.expiresAt <= at || !kindEnabled(profile, m.kind)) {
      result.dropped.push(m);
      continue;
    }
    if (m.dueAt > at) {
      result.held.push(m);
      continue;
    }
    if (m.urgency === "digest") {
      result.queued.push(m);
      continue;
    }
    if (quiet && !urgent && !askedFor) {
      result.held.push(m);
      continue;
    }
    if (talking && !urgent) {
      result.held.push(m);
      continue;
    }
    if (input.inMeeting && !urgent && !THROUGH_MEETINGS.includes(m.kind)) {
      result.held.push(m);
      continue;
    }
    const last = state.lastSentByKind[m.kind];
    const cooldown = cooldownMinutes(profile, m.kind);
    if (last && cooldown > 0 && now.getTime() - new Date(last).getTime() < cooldown * MINUTE && !urgent) {
      result.queued.push(m);
      continue;
    }
    if (overBudget && !urgent && !askedFor) {
      result.queued.push(m);
      continue;
    }
    result.deliver.push(m);
  }
  return result;
}

/**
 * What goes out with a delivery from the digest: everything when a brief or
 * wrap is going out anyway, otherwise nothing, so a digest never becomes a
 * second stream of interruptions.
 */
export function digestToFlush(state: MagicState, deliver: Moment[], now: Date): Moment[] {
  if (!deliver.some((m) => m.kind === "brief" || m.kind === "wrap")) return [];
  const at = now.toISOString();
  return state.digest.filter((m) => m.expiresAt > at);
}

/** Record a tick's decisions. Returns the new state; the input is not changed. */
export function commit(state: MagicState, result: GateResult, flushed: Moment[], profile: Profile, now: Date): MagicState {
  const at = now.toISOString();
  const next: MagicState = {
    ...state,
    ledger: [...state.ledger],
    digest: [...state.digest],
    lastSentByKind: { ...state.lastSentByKind },
    sentByDay: { ...state.sentByDay },
  };
  for (const m of result.deliver) {
    next.ledger.push({ key: m.key, kind: m.kind, at, status: "sent", summary: m.summary });
    next.lastSentByKind[m.kind] = at;
  }
  for (const m of result.queued) {
    next.ledger.push({ key: m.key, kind: m.kind, at, status: "queued" });
    next.digest.push(m);
  }
  for (const m of result.dropped) next.ledger.push({ key: m.key, kind: m.kind, at, status: "dropped" });
  if (result.deliver.length) {
    next.lastDeliveredAt = at;
    if (profile.timeZone) {
      const day = localDate(now, profile.timeZone);
      next.sentByDay[day] = (next.sentByDay[day] ?? 0) + 1;
    }
  }
  for (const m of flushed) next.ledger.push({ key: `${m.key}#digest`, kind: m.kind, at, status: "sent", summary: m.summary });
  if (flushed.length) {
    const gone = new Set(flushed.map((m) => m.key));
    next.digest = next.digest.filter((m) => !gone.has(m.key));
  }
  return prune(next, now);
}

/** Forget what can no longer matter, so state files stay small. */
export function prune(state: MagicState, now: Date): MagicState {
  const at = now.toISOString();
  const ledgerCutoff = new Date(now.getTime() - 14 * DAY).toISOString();
  const travelCutoff = new Date(now.getTime() - 6 * HOUR).toISOString();
  const days = Object.keys(state.sentByDay).sort().slice(-14);
  return {
    ...state,
    ledger: state.ledger.filter((e) => e.at >= ledgerCutoff).slice(-2000),
    digest: state.digest.filter((m) => m.expiresAt > at).slice(-50),
    sentByDay: Object.fromEntries(days.map((d) => [d, state.sentByDay[d]!])),
    travel: Object.fromEntries(Object.entries(state.travel).filter(([, t]) => t.at >= travelCutoff)),
  };
}

export function emptyState(): MagicState {
  return { ledger: [], digest: [], lastSentByKind: {}, sentByDay: {}, travel: {}, feedback: {}, health: {} };
}

/** A state from whatever is on disk, missing fields filled in. */
export function normalizeState(input: unknown): MagicState {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<MagicState>;
  const base = emptyState();
  return {
    ...base,
    ...raw,
    ledger: Array.isArray(raw.ledger) ? raw.ledger : base.ledger,
    digest: Array.isArray(raw.digest) ? raw.digest : base.digest,
    lastSentByKind: raw.lastSentByKind ?? {},
    sentByDay: raw.sentByDay ?? {},
    travel: raw.travel ?? {},
    feedback: raw.feedback ?? {},
    health: raw.health ?? {},
  };
}
