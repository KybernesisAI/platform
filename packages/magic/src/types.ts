/**
 * The shapes magic works with. Everything here is plain JSON so it can sit in a
 * file on the agent's host and survive a restart.
 */

/** The kinds of moment magic knows how to notice. */
export type MomentKind =
  | "brief"
  | "wrap"
  | "meeting_prep"
  | "leave"
  | "conflict"
  | "reply_owed"
  | "vip_mail"
  | "reminder";

export const MOMENT_KINDS: readonly MomentKind[] = [
  "brief",
  "wrap",
  "meeting_prep",
  "leave",
  "conflict",
  "reply_owed",
  "vip_mail",
  "reminder",
];

/**
 * How soon a moment is worth saying.
 *
 * `now` interrupts, `soon` interrupts unless the person is busy, `digest` waits
 * for the next brief or wrap.
 */
export type Urgency = "now" | "soon" | "digest";

/** How far the agent goes on its own: say it, offer a step, or prepare it. */
export type Boldness = "tell" | "suggest" | "draft";

/** Something worth telling the person, found by code before any model runs. */
export interface Moment {
  kind: MomentKind;
  /** Stable identity, so the same moment is never said twice. */
  key: string;
  /** When it becomes worth saying (ISO). */
  dueAt: string;
  /** After this it is not worth saying at all (ISO). */
  expiresAt: string;
  urgency: Urgency;
  /** Allowed through quiet hours and busy time: the person would want it now. */
  urgent?: boolean;
  /** 0..1, how sure the detector is that this matters. */
  confidence: number;
  /** One line in plain words, for the model and for logs. */
  summary: string;
  /** The facts behind it, passed to the model as context. */
  evidence: Record<string, unknown>;
  /** The one next step the agent could offer. */
  offer?: string;
}

export interface KindSettings {
  enabled?: boolean;
  /** Minimum minutes between two moments of this kind. */
  cooldownMinutes?: number;
}

/** A named place the person goes, written as an address a map can find. */
export interface Places {
  home?: string;
  office?: string;
}

/** What the person told the agent about how they want to be helped. */
export interface Profile {
  enabled: boolean;
  /** IANA time zone, such as Asia/Bangkok. Required before magic runs. */
  timeZone: string | null;
  /** Their name, so the agent can address them. */
  name?: string;
  quietHours: { start: string; end: string };
  /** Local time for the morning brief (HH:MM), or null for none. */
  briefAt: string | null;
  /** Local time for the evening wrap (HH:MM), or null for none. */
  wrapAt: string | null;
  /** Most interruptions in one local day; the rest wait for a digest. */
  dailyBudget: number;
  /** Minutes before a meeting to offer prep. */
  meetingLeadMinutes: number;
  /** Extra minutes added to travel before saying it is time to leave. */
  leaveBufferMinutes: number;
  /** Travel minutes to assume when no live traffic estimate is available. */
  travelFallbackMinutes: number;
  travelMode: "DRIVE" | "TRANSIT" | "WALK" | "BICYCLE" | "TWO_WHEELER";
  /** Hours an important email may wait before a nudge to reply. */
  replyAfterHours: number;
  /** How far back to look for unanswered email. */
  replyLookbackDays: number;
  /** Email addresses or domains whose mail always matters. */
  vips: string[];
  places: Places;
  workHours: { start: string; end: string; days: number[] };
  boldness: Boldness;
  kinds: Partial<Record<MomentKind, KindSettings>>;
}

/** Where to reach the person: the last conversation they had with the agent. */
export interface Surface {
  /** The channel kind the hook saw, such as "chat-sdk" or "kyb". */
  kind?: string;
  /** The channel's address for that conversation (a thread id, "studio"). */
  token?: string;
  /** The person's principal, as the channel verified it. */
  auth: PersonAuth;
  /** When this surface was last used by the person (ISO). */
  at: string;
}

/** A verified user principal, stored so a background turn can run as them. */
export interface PersonAuth {
  authenticator: string;
  principalId: string;
  principalType: "user";
  subject?: string;
  issuer?: string;
  /** Same shape as eve's session auth attributes. */
  attributes: Record<string, string | readonly string[]>;
}

/** A reminder the person asked for. */
export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  createdAt: string;
}

export interface LedgerEntry {
  key: string;
  kind: MomentKind;
  at: string;
  status: "sent" | "queued" | "dropped";
  /** What was said, kept for sent moments so later turns know. */
  summary?: string;
}

/** A calendar event, reduced to what magic needs. */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees: { email: string; name?: string; self?: boolean; response?: string }[];
  /** The person's own answer to the invitation, when known. */
  response?: string;
  /** Marked free rather than busy. */
  free?: boolean;
  link?: string;
}

/** An email, reduced to what magic needs. */
export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  fromName?: string;
  to?: string;
  subject: string;
  snippet?: string;
  at: string;
  labels: string[];
}

export interface TravelEstimate {
  minutes: number;
  /** True when this is the fallback guess, not a live traffic estimate. */
  estimated: boolean;
  origin: string;
  destination: string;
  at: string;
}

/** Everything magic keeps between ticks for one person. */
export interface MagicState {
  ledger: LedgerEntry[];
  /** Digest moments waiting for the next brief or wrap. */
  digest: Moment[];
  lastSentByKind: Partial<Record<MomentKind, string>>;
  /** Interruptions sent per local day (YYYY-MM-DD). */
  sentByDay: Record<string, number>;
  /** When the person last wrote to the agent themselves (ISO). */
  lastActiveAt?: string;
  /** When magic last delivered (ISO). */
  lastDeliveredAt?: string;
  calendar?: { at: string; events: CalendarEvent[] };
  inbox?: { at: string; inbound: EmailMessage[]; sent: EmailMessage[] };
  travel: Record<string, TravelEstimate>;
  feedback: Partial<Record<MomentKind, { useful: number; notUseful: number }>>;
  /** The last problem reaching a source, so status can say so plainly. */
  health: Record<string, { at: string; error: string } | undefined>;
}

/** What one tick decided to say to one person. */
export interface MagicDispatch {
  principalId: string;
  surface: Surface;
  packet: string;
  moments: Moment[];
}
