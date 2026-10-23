import { addMs, clockIn, DAY, HOUR, inWindow, localDate, localMinutes, localParts, MINUTE, parseClock } from "./time.js";
import type { CalendarEvent, EmailMessage, MagicState, Moment, Profile, Reminder, TravelEstimate } from "./types.js";

/**
 * The detectors: plain code that looks at the person's day and says what, if
 * anything, is worth a word. No model runs here. Most ticks find nothing, and
 * that is the point: the model is only woken for a real candidate.
 */

export interface DetectInput {
  profile: Profile;
  state: MagicState;
  now: Date;
  events: CalendarEvent[];
  inbound: EmailMessage[];
  sent: EmailMessage[];
  reminders: Reminder[];
  /** The person's own addresses, so their mail to themselves is not "owed". */
  selfEmails?: string[];
}

const VIDEO =
  /(zoom\.us|meet\.google|teams\.microsoft|teams\.live|webex|whereby|around\.co|gotomeeting|chime\.aws|\bzoom\b|google meet|hangouts|microsoft teams|teams meeting|\bskype\b|facetime)/i;
const NOT_A_PLACE = /^(online|virtual|remote|tbd|tba|phone|call|video call|n\/a|none|-)$/i;

/** True when a location is somewhere you travel to, not a link or a dial-in. */
export function isPhysicalLocation(location: string | undefined): location is string {
  if (!location) return false;
  const value = location.trim();
  if (value.length < 3 || NOT_A_PLACE.test(value)) return false;
  if (/^https?:\/\//i.test(value) || VIDEO.test(value)) return false;
  if (/^\+?[\d\s().-]{7,}$/.test(value)) return false;
  return true;
}

/** Events the person actually has to be at: timed, busy, not declined. */
export function attendable(events: CalendarEvent[]): CalendarEvent[] {
  return events.filter((e) => !e.allDay && !e.free && e.response !== "declined");
}

export function eventKey(event: CalendarEvent): string {
  return `${event.id}@${event.start}`;
}

function others(event: CalendarEvent): CalendarEvent["attendees"] {
  return event.attendees.filter((a) => !a.self && !/resource\.calendar\.google\.com$/.test(a.email));
}

/**
 * Where the person will be coming from for an event: the previous in-person
 * event if it ends within two hours, else the office in work hours, else home.
 */
export function legFor(
  event: CalendarEvent,
  events: CalendarEvent[],
  profile: Profile,
): { origin: string; destination: string } | undefined {
  if (!isPhysicalLocation(event.location) || !profile.timeZone) return undefined;
  const start = new Date(event.start);
  const before = attendable(events)
    .filter((e) => e !== event && e.end <= event.start && new Date(e.end).getTime() >= start.getTime() - 2 * HOUR)
    .filter((e) => isPhysicalLocation(e.location))
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  let origin = before?.location;
  if (!origin) {
    const parts = localParts(start, profile.timeZone);
    const minutes = parts.hour * 60 + parts.minute;
    const workStart = parseClock(profile.workHours.start) ?? 540;
    const workEnd = parseClock(profile.workHours.end) ?? 1080;
    const atWork = profile.workHours.days.includes(parts.weekday) && minutes >= workStart && minutes <= workEnd;
    origin = (atWork ? profile.places.office : undefined) ?? profile.places.home ?? profile.places.office;
  }
  if (!origin) return undefined;
  if (origin.trim().toLowerCase() === event.location.trim().toLowerCase()) return undefined;
  return { origin, destination: event.location };
}

const AUTOMATED_SENDER =
  /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|mailer|newsletters?|news|updates?|bounces?|billing|receipts?|invoices?|marketing|automated|digest)(@|[._+-])/i;
const BULK_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM", "TRASH"];

export function isVip(email: string, vips: string[]): boolean {
  const address = email.toLowerCase();
  return vips.some((v) => (v.includes("@") ? address === v : address.endsWith(`@${v}`) || address.endsWith(`.${v}`)));
}

function fromAPerson(mail: EmailMessage): boolean {
  return !AUTOMATED_SENDER.test(mail.from) && !mail.labels.some((l) => BULK_LABELS.includes(l));
}

/** Threads where someone who matters wrote last and the person has not answered. */
export function owedReplies(input: Pick<DetectInput, "profile" | "now" | "inbound" | "sent" | "selfEmails">): EmailMessage[] {
  const { profile, now, inbound, sent } = input;
  const self = new Set([...(input.selfEmails ?? []), ...sent.map((m) => m.from)].map((e) => e.toLowerCase()));
  const lastSent = new Map<string, string>();
  for (const m of sent) if ((lastSent.get(m.threadId) ?? "") < m.at) lastSent.set(m.threadId, m.at);
  const latest = new Map<string, EmailMessage>();
  for (const m of inbound) {
    if (self.has(m.from)) continue;
    const prev = latest.get(m.threadId);
    if (!prev || prev.at < m.at) latest.set(m.threadId, m);
  }
  const oldest = now.getTime() - profile.replyLookbackDays * DAY;
  const youngest = now.getTime() - profile.replyAfterHours * HOUR;
  return [...latest.values()]
    .filter((m) => {
      const at = new Date(m.at).getTime();
      if (at < oldest || at > youngest) return false;
      if (m.labels.length && !m.labels.includes("INBOX")) return false;
      if ((lastSent.get(m.threadId) ?? "") > m.at) return false;
      const vip = isVip(m.from, profile.vips);
      if (!vip && !fromAPerson(m)) return false;
      return vip || m.labels.includes("IMPORTANT") || m.labels.includes("STARRED");
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

function agendaLine(e: CalendarEvent, timeZone: string): Record<string, unknown> {
  const people = others(e);
  return {
    at: `${clockIn(new Date(e.start), timeZone)}–${clockIn(new Date(e.end), timeZone)}`,
    title: e.title,
    ...(e.location ? { where: e.location } : {}),
    ...(people.length ? { with: people.slice(0, 6).map((a) => a.name ?? a.email) } : {}),
  };
}

function mailLine(m: EmailMessage): Record<string, unknown> {
  return { from: m.fromName ? `${m.fromName} <${m.from}>` : m.from, subject: m.subject, at: m.at, threadId: m.threadId };
}

/** The end of a local window that started at `startMinutes` and lasts `length` minutes. */
function windowEnd(now: Date, timeZone: string, startMinutes: number, length: number): Date {
  const elapsed = (localMinutes(now, timeZone) - startMinutes + 1440) % 1440;
  return addMs(now, (length - elapsed) * MINUTE);
}

export function detect(input: DetectInput): Moment[] {
  const { profile, state, now, reminders } = input;
  const tz = profile.timeZone;
  if (!tz) return [];
  const moments: Moment[] = [];
  const nowMs = now.getTime();
  const events = attendable(input.events);
  const today = localDate(now, tz);
  const minutes = localMinutes(now, tz);
  const owed = owedReplies(input);

  // Morning brief and evening wrap: once a day, in a three-hour window from
  // the time the person picked, so a restart at 07:31 still sends it.
  const brief = parseClock(profile.briefAt);
  if (brief !== undefined && inWindow(minutes, brief, brief + 180)) {
    const todays = events.filter((e) => localDate(new Date(e.start), tz) === today && e.end > now.toISOString());
    moments.push({
      kind: "brief",
      key: `brief:${today}`,
      dueAt: now.toISOString(),
      expiresAt: windowEnd(now, tz, brief, 180).toISOString(),
      urgency: "now",
      confidence: 0.9,
      summary: `Morning brief for ${today}: ${todays.length} event(s), ${owed.length} reply(ies) owed.`,
      evidence: {
        agenda: todays.slice(0, 12).map((e) => agendaLine(e, tz)),
        owedReplies: owed.slice(0, 5).map(mailLine),
        remindersToday: reminders
          .filter((r) => localDate(new Date(r.dueAt), tz) === today)
          .map((r) => ({ at: clockIn(new Date(r.dueAt), tz), text: r.text })),
      },
      offer: "The one thing in today that most needs them, and help with it.",
    });
  }
  const wrap = parseClock(profile.wrapAt);
  if (wrap !== undefined && inWindow(minutes, wrap, wrap + 180)) {
    const tomorrow = localDate(addMs(now, DAY), tz);
    const next = events.filter((e) => localDate(new Date(e.start), tz) === tomorrow);
    moments.push({
      kind: "wrap",
      key: `wrap:${today}`,
      dueAt: now.toISOString(),
      expiresAt: windowEnd(now, tz, wrap, 180).toISOString(),
      urgency: "now",
      confidence: 0.85,
      summary: `Evening wrap for ${today}: ${next.length} event(s) tomorrow, ${owed.length} reply(ies) owed.`,
      evidence: {
        tomorrow: next.slice(0, 8).map((e) => agendaLine(e, tz)),
        owedReplies: owed.slice(0, 5).map(mailLine),
      },
      offer: "Anything to settle tonight so tomorrow starts clean.",
    });
  }

  for (const e of events) {
    const start = new Date(e.start).getTime();
    const until = (start - nowMs) / MINUTE;
    if (until <= 0) continue;

    // Prep: only for meetings with other people, inside the lead time.
    const people = others(e);
    if (until <= profile.meetingLeadMinutes && (people.length > 0 || e.description)) {
      moments.push({
        kind: "meeting_prep",
        key: `prep:${eventKey(e)}`,
        dueAt: now.toISOString(),
        expiresAt: e.start,
        urgency: "soon",
        confidence: people.length ? 0.8 : 0.6,
        summary: `"${e.title}" starts at ${clockIn(new Date(e.start), tz)}${people.length ? ` with ${people.length} other(s)` : ""}.`,
        evidence: {
          ...agendaLine(e, tz),
          minutesAway: Math.round(until),
          attendees: people.slice(0, 10).map((a) => ({ email: a.email, ...(a.name ? { name: a.name } : {}), ...(a.response ? { response: a.response } : {}) })),
          ...(e.link ? { link: e.link } : {}),
          ...(e.description ? { notes: e.description.slice(0, 300) } : {}),
        },
        offer: "A two-line brief on who is in it and what is open with them.",
      });
    }

    // Time to leave: travel plus buffer before the start, said ten minutes
    // ahead of the moment they must go.
    if (isPhysicalLocation(e.location) && until <= 4 * 60) {
      const leg = legFor(e, events, profile);
      const travel: TravelEstimate | undefined = state.travel[eventKey(e)];
      const travelMinutes = travel?.minutes ?? profile.travelFallbackMinutes;
      if (!leg && !travel) continue;
      const leaveAt = start - (travelMinutes + profile.leaveBufferMinutes) * MINUTE;
      if (nowMs >= leaveAt - 10 * MINUTE) {
        const estimated = !travel || travel.estimated;
        moments.push({
          kind: "leave",
          key: `leave:${eventKey(e)}`,
          dueAt: new Date(leaveAt - 10 * MINUTE).toISOString(),
          expiresAt: e.start,
          urgency: "now",
          urgent: nowMs >= leaveAt - 5 * MINUTE,
          confidence: estimated ? 0.6 : 0.9,
          summary: `Leave by ${clockIn(new Date(leaveAt), tz)} for "${e.title}" at ${e.location}.`,
          evidence: {
            ...agendaLine(e, tz),
            leaveBy: clockIn(new Date(leaveAt), tz),
            travelMinutes,
            liveTraffic: !estimated,
            ...(leg ? { from: travel?.origin ?? leg.origin, to: travel?.destination ?? leg.destination } : {}),
          },
          offer: estimated ? "Ask where they are leaving from to time it properly." : "Directions, or a heads-up to the others if they will be late.",
        });
      }
    }
  }

  // Double bookings in the next day, once per pair.
  const soon = events.filter((e) => new Date(e.start).getTime() - nowMs < DAY && e.end > now.toISOString());
  for (let i = 0; i < soon.length; i++) {
    for (let j = i + 1; j < soon.length; j++) {
      const a = soon[i]!;
      const b = soon[j]!;
      if (!(a.start < b.end && b.start < a.end)) continue;
      const first = a.start <= b.start ? a : b;
      const startsIn = new Date(first.start).getTime() - nowMs;
      moments.push({
        kind: "conflict",
        key: `conflict:${[eventKey(a), eventKey(b)].sort().join("|")}`,
        dueAt: now.toISOString(),
        expiresAt: first.start > now.toISOString() ? first.start : (a.end < b.end ? a.end : b.end),
        urgency: startsIn < 3 * HOUR ? "soon" : "digest",
        confidence: 0.85,
        summary: `"${a.title}" and "${b.title}" overlap.`,
        evidence: { events: [agendaLine(a, tz), agendaLine(b, tz)] },
        offer: "Which one to keep, and a note to move the other.",
      });
    }
  }

  // Mail from someone who always matters, while it is fresh.
  for (const m of input.inbound) {
    const age = nowMs - new Date(m.at).getTime();
    if (age < 0 || age > 30 * MINUTE || !isVip(m.from, profile.vips)) continue;
    if (m.labels.length && !m.labels.includes("INBOX")) continue;
    moments.push({
      kind: "vip_mail",
      key: `vip:${m.id}`,
      dueAt: now.toISOString(),
      expiresAt: new Date(new Date(m.at).getTime() + 2 * HOUR).toISOString(),
      urgency: "soon",
      confidence: 0.85,
      summary: `New mail from ${m.fromName ?? m.from}: "${m.subject}".`,
      evidence: { ...mailLine(m), ...(m.snippet ? { snippet: m.snippet } : {}) },
      offer: "What it asks for, and a reply if one is needed.",
    });
  }

  for (const m of owed) {
    const vip = isVip(m.from, profile.vips);
    moments.push({
      kind: "reply_owed",
      key: `reply:${m.threadId}:${m.id}`,
      dueAt: now.toISOString(),
      expiresAt: new Date(new Date(m.at).getTime() + profile.replyLookbackDays * DAY).toISOString(),
      urgency: vip ? "soon" : "digest",
      confidence: vip ? 0.85 : 0.7,
      summary: `${m.fromName ?? m.from} is waiting on a reply to "${m.subject}".`,
      evidence: { ...mailLine(m), ...(m.snippet ? { snippet: m.snippet } : {}), waitingHours: Math.round((nowMs - new Date(m.at).getTime()) / HOUR) },
      offer: "A short reply they can send or change.",
    });
  }

  for (const r of reminders) {
    const due = new Date(r.dueAt).getTime();
    if (due > nowMs) continue;
    moments.push({
      kind: "reminder",
      key: `reminder:${r.id}`,
      dueAt: r.dueAt,
      expiresAt: new Date(due + 12 * HOUR).toISOString(),
      urgency: "now",
      urgent: true,
      confidence: 1,
      summary: `Reminder: ${r.text}`,
      evidence: { text: r.text, setFor: clockIn(new Date(r.dueAt), tz), late: Math.round((nowMs - due) / MINUTE) > 15 },
    });
  }

  return moments;
}

/** The event the person is in right now, if any. */
export function currentEvent(events: CalendarEvent[], now: Date): CalendarEvent | undefined {
  const at = now.toISOString();
  return attendable(events).find((e) => e.start <= at && e.end > at);
}
