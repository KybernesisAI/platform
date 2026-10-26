import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attendable, currentEvent, detect, eventKey, legFor } from "./detect.js";
import { commit, digestToFlush, emptyState, gate, normalizeState } from "./gate.js";
import { applyFeedback, type FeedbackVerdict } from "./feedback.js";
import { buildPacket, isMagicMessage } from "./packet.js";
import { parseCalendarEvents, parseEmails } from "./parse.js";
import { DEFAULT_PROFILE, normalizeProfile, notReady, updateProfile } from "./profile.js";
import { HOUR, MINUTE } from "./time.js";
import type {
  CalendarEvent,
  MagicDispatch,
  MagicState,
  MomentKind,
  PersonAuth,
  Profile,
  Reminder,
  Surface,
  TravelEstimate,
} from "./types.js";

/**
 * The Node side of magic: where each person's settings and state live, how
 * their calendar and mail are read, live travel times, and the tick.
 *
 * Files, not a database: one directory per person under the agent's own app
 * directory, each file written whole and renamed into place, so a crash
 * mid-write leaves the previous version rather than half a file. Writers in
 * this process are serialized per file; the agent runs as one process.
 */

export interface MagicOptions {
  /** The agent's app directory. Defaults to EVE_APP_DIR, then the working directory. */
  appRoot?: string;
  /** Where magic keeps its files. Defaults to `<appRoot>/.kyb/magic`. */
  dir?: string;
  /** Control-plane base URL. Defaults to KYBERNESIS_ISSUER. */
  issuer?: string;
  /** This agent's control-plane credential. Defaults to KYBERNESIS_AGENT_CREDENTIAL. */
  credential?: string;
  /** Google Maps Platform key for live traffic. Defaults to GOOGLE_MAPS_API_KEY; optional. */
  mapsKey?: string;
  /** How often to re-read the calendar, in minutes. */
  calendarEveryMinutes?: number;
  /** How often to re-read the inbox, in minutes. */
  inboxEveryMinutes?: number;
  /** Replace the network, for tests. */
  fetch?: typeof fetch;
}

function dirOf(options: MagicOptions): string {
  return options.dir ?? join(options.appRoot ?? process.env.EVE_APP_DIR ?? process.cwd(), ".kyb", "magic");
}

/** A directory name for a principal id: itself when it is plain, else a hash. */
export function personKey(principalId: string): string {
  return /^[A-Za-z0-9_-]{1,100}$/.test(principalId)
    ? principalId
    : createHash("sha256").update(principalId).digest("hex").slice(0, 40);
}

function personDir(options: MagicOptions, principalId: string): string {
  return join(dirOf(options), "people", personKey(principalId));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` with no other writer of `path` in this process running at the same time. */
async function exclusive<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = chains.get(path) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const settled = run.catch(() => undefined);
  chains.set(path, settled);
  try {
    return await run;
  } finally {
    if (chains.get(path) === settled) chains.delete(path);
  }
}

const file = (options: MagicOptions, principalId: string, name: string) => join(personDir(options, principalId), `${name}.json`);

export function readProfile(principalId: string, options: MagicOptions = {}): Profile {
  return normalizeProfile(readJson(file(options, principalId, "profile")) ?? DEFAULT_PROFILE);
}

export function readState(principalId: string, options: MagicOptions = {}): MagicState {
  return normalizeState(readJson(file(options, principalId, "state")) ?? emptyState());
}

export function readSurface(principalId: string, options: MagicOptions = {}): Surface | undefined {
  const raw = readJson(file(options, principalId, "surface")) as Surface | undefined;
  return raw?.auth?.principalType === "user" && raw.auth.principalId === principalId ? raw : undefined;
}

export function readReminders(principalId: string, options: MagicOptions = {}): Reminder[] {
  const raw = readJson(file(options, principalId, "reminders"));
  return Array.isArray(raw) ? (raw as Reminder[]).filter((r) => r && r.id && r.text && r.dueAt) : [];
}

/** Change the person's settings. Only ever their own: the caller passes the verified principal. */
export async function updateSettings(principalId: string, change: Record<string, unknown>, options: MagicOptions = {}): Promise<Profile> {
  const path = file(options, principalId, "profile");
  return exclusive(path, () => {
    const next = updateProfile(readProfile(principalId, options), change);
    writeJson(path, next);
    return next;
  });
}

export async function addReminder(principalId: string, text: string, dueAt: Date, options: MagicOptions = {}): Promise<Reminder> {
  const path = file(options, principalId, "reminders");
  return exclusive(path, () => {
    const reminder: Reminder = {
      id: randomUUID().slice(0, 8),
      text: text.trim().slice(0, 500),
      dueAt: dueAt.toISOString(),
      createdAt: new Date().toISOString(),
    };
    const list = readReminders(principalId, options);
    if (list.length >= 200) throw new Error("There are already 200 reminders waiting. Cancel some first.");
    writeJson(path, [...list, reminder].sort((a, b) => a.dueAt.localeCompare(b.dueAt)));
    return reminder;
  });
}

export async function cancelReminder(principalId: string, id: string, options: MagicOptions = {}): Promise<boolean> {
  const path = file(options, principalId, "reminders");
  return exclusive(path, () => {
    const list = readReminders(principalId, options);
    const kept = list.filter((r) => r.id !== id);
    if (kept.length === list.length) return false;
    writeJson(path, kept);
    return true;
  });
}

async function removeReminders(principalId: string, ids: string[], options: MagicOptions): Promise<void> {
  if (!ids.length) return;
  const path = file(options, principalId, "reminders");
  await exclusive(path, () => writeJson(path, readReminders(principalId, options).filter((r) => !ids.includes(r.id))));
}

export async function recordFeedback(principalId: string, kind: MomentKind, verdict: FeedbackVerdict, options: MagicOptions = {}): Promise<string> {
  const profilePath = file(options, principalId, "profile");
  const statePath = file(options, principalId, "state");
  return exclusive(profilePath, () =>
    exclusive(statePath, () => {
      const result = applyFeedback(readProfile(principalId, options), readState(principalId, options), kind, verdict);
      writeJson(profilePath, result.profile);
      writeJson(statePath, result.state);
      return result.note;
    }),
  );
}

/** Keep only what a background turn needs from a verified principal. */
export function personAuth(auth: unknown): PersonAuth | undefined {
  const a = auth as Partial<PersonAuth> | null | undefined;
  if (!a || a.principalType !== "user" || typeof a.principalId !== "string" || !a.principalId) return undefined;
  return {
    authenticator: String(a.authenticator ?? "kybernesis"),
    principalId: a.principalId,
    principalType: "user",
    ...(a.subject ? { subject: String(a.subject) } : {}),
    ...(a.issuer ? { issuer: String(a.issuer) } : {}),
    attributes: Object.fromEntries(
      Object.entries(a.attributes && typeof a.attributes === "object" ? a.attributes : {}).filter(
        ([, v]) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string")),
      ),
    ) as PersonAuth["attributes"],
  };
}

export interface TurnSeen {
  auth: unknown;
  channelKind?: string;
  continuationToken?: string;
  /** The message text, so magic's own background turns are not counted. */
  text?: string;
  at?: Date;
}

/**
 * Remember where a person last talked to the agent, so a heads-up lands in
 * that same conversation. Called by the hook for every message; ignores
 * anything that is not a verified person, and magic's own turns.
 */
export async function recordTurn(turn: TurnSeen, options: MagicOptions = {}): Promise<void> {
  if (isMagicMessage(turn.text)) return;
  const auth = personAuth(turn.auth);
  if (!auth) return;
  const path = file(options, auth.principalId, "surface");
  await exclusive(path, () => {
    // A turn with no channel at all (a delegated child session) still counts as
    // the person being active, but must not move their heads-ups off the
    // conversation they actually use.
    const previous = readSurface(auth.principalId, options);
    const located = Boolean(turn.channelKind || turn.continuationToken);
    const kind = located ? turn.channelKind : previous?.kind;
    const token = located ? turn.continuationToken : previous?.token;
    const surface: Surface = {
      ...(kind ? { kind } : {}),
      ...(token ? { token } : {}),
      auth,
      at: (turn.at ?? new Date()).toISOString(),
    };
    writeJson(path, surface);
  });
}

export async function noteDeliveryFailure(principalId: string, error: unknown, options: MagicOptions = {}): Promise<void> {
  const path = file(options, principalId, "state");
  await exclusive(path, () => {
    const state = readState(principalId, options);
    state.health.delivery = { at: new Date().toISOString(), error: errorText(error) };
    writeJson(path, state);
  });
  console.error(`[magic] delivery failed for ${personKey(principalId)}: ${errorText(error)}`);
}

/** Every person magic has a directory for. */
export function people(options: MagicOptions = {}): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(dirOf(options), "people"));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const surface = readJson(join(dirOf(options), "people", entry, "surface.json")) as Surface | undefined;
    if (surface?.auth?.principalId && personKey(surface.auth.principalId) === entry) ids.push(surface.auth.principalId);
  }
  return ids;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

// ── Connectors ────────────────────────────────────────────────────────────

interface RemoteTool {
  slug: string;
  toolkit?: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

function issuerOf(options: MagicOptions): string {
  return (options.issuer ?? process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai").replace(/\/$/, "");
}

function credentialOf(options: MagicOptions): string | undefined {
  return options.credential ?? process.env.KYBERNESIS_AGENT_CREDENTIAL;
}

/** Connected accounts per service slug, as the control plane reports them. */
type Accounts = Record<string, { id: string; label: string | null }[]>;

interface Connected {
  tools: RemoteTool[];
  accounts: Accounts;
}

const toolCache = new Map<string, { at: number } & Connected>();

async function connectorTools(user: string, options: MagicOptions): Promise<Connected> {
  // A substituted network (tests) gets no cache, so one fake never answers for another.
  const cached = options.fetch ? undefined : toolCache.get(user);
  if (cached && Date.now() - cached.at < 10 * MINUTE) return cached;
  const credential = credentialOf(options);
  if (!credential) throw new Error("This agent has no control-plane credential, so it cannot read connected services.");
  const res = await (options.fetch ?? fetch)(`${issuerOf(options)}/api/connectors/tools`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ user }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The control plane would not list connected services (${res.status}).`);
  const body = (await res.json()) as { tools?: RemoteTool[]; accounts?: Accounts };
  const connected: Connected = {
    tools: body.tools ?? [],
    // Lower-cased: the toolkit on a tool and the slug on an account do not agree on case.
    accounts: Object.fromEntries(Object.entries(body.accounts ?? {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v : []])),
  };
  if (!options.fetch) toolCache.set(user, { at: Date.now(), ...connected });
  return connected;
}

async function runConnector(
  user: string,
  tool: string,
  args: Record<string, unknown>,
  options: MagicOptions,
  account?: string,
): Promise<unknown> {
  const credential = credentialOf(options);
  if (!credential) throw new Error("This agent has no control-plane credential.");
  const res = await (options.fetch ?? fetch)(`${issuerOf(options)}/api/connectors/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ tool, arguments: args, user, ...(account ? { account } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error ?? `The ${tool} call failed (${res.status}).`);
  return body.result;
}

/** The first connected tool whose slug matches, in order of preference. */
function pick(tools: RemoteTool[], patterns: RegExp[]): RemoteTool | undefined {
  for (const pattern of patterns) {
    const hit = tools.find((t) => pattern.test(t.slug));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Run one read against every account the person connected for a tool's
 * service, and put the results together.
 *
 * With one account the control plane picks it; with two or more it refuses
 * to guess ("There are 2 accounts connected… Say which one to use"), which
 * failed every inbox read for anyone with a work and a personal Gmail. A read
 * is safe to make as each of their own accounts, so magic reads them all.
 * One account failing does not hide the others.
 */
async function readEach<T>(
  user: string,
  tool: RemoteTool,
  connected: Connected,
  args: Record<string, unknown>,
  parse: (result: unknown) => T[],
  options: MagicOptions,
): Promise<T[]> {
  const accounts = connected.accounts[(tool.toolkit ?? "").toLowerCase()] ?? [];
  const ids: (string | undefined)[] = accounts.length > 1 ? accounts.map((a) => a.id) : [undefined];
  const settled = await Promise.allSettled(ids.map((id) => runConnector(user, tool.slug, args, options, id)));
  const read = settled.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled");
  if (!read.length) throw (settled[0] as PromiseRejectedResult).reason;
  return read.flatMap((r) => parse(r.value));
}

/**
 * Arguments named the way this tool's schema names them. The same field is
 * camelCase in one version of a tool and snake_case in the next; sending a
 * name the schema does not know is either ignored or refused, so each value
 * goes under the first spelling the schema has. With no schema, the first.
 */
export function argsFor(tool: RemoteTool, wanted: [string[], unknown][]): Record<string, unknown> {
  const props = tool.inputSchema?.properties;
  const out: Record<string, unknown> = {};
  for (const [names, value] of wanted) {
    const name = props ? names.find((n) => n in props) : names[0];
    if (name) out[name] = value;
  }
  return out;
}

const CALENDAR_TOOLS = [/^GOOGLECALENDAR_EVENTS_LIST$/, /^GOOGLECALENDAR_FIND_EVENT$/, /^GOOGLECALENDAR_.*LIST.*EVENTS?$/];
const MAIL_TOOLS = [/^GMAIL_FETCH_EMAILS$/, /^GMAIL_.*FETCH.*(EMAILS|MESSAGES)$/, /^GMAIL_LIST_MESSAGES$/];

/** Once each: the same meeting shows up on both calendars when both are invited. */
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function fetchCalendar(user: string, now: Date, options: MagicOptions = {}): Promise<CalendarEvent[]> {
  const connected = await connectorTools(user, options);
  const tool = pick(connected.tools, CALENDAR_TOOLS);
  if (!tool) throw new Error("Google Calendar is not connected.");
  const args = argsFor(tool, [
    [["calendarId", "calendar_id"], "primary"],
    [["timeMin", "time_min"], new Date(now.getTime() - 14 * HOUR).toISOString()],
    [["timeMax", "time_max"], new Date(now.getTime() + 36 * HOUR).toISOString()],
    [["singleEvents", "single_events"], true],
    [["orderBy", "order_by"], "startTime"],
    [["maxResults", "max_results"], 100],
  ]);
  const events = await readEach(user, tool, connected, args, parseCalendarEvents, options);
  return unique(events, eventKey);
}

export async function fetchMail(user: string, query: string, options: MagicOptions = {}) {
  const connected = await connectorTools(user, options);
  const tool = pick(connected.tools, MAIL_TOOLS);
  if (!tool) throw new Error("Gmail is not connected.");
  const args = argsFor(tool, [
    [["query", "q"], query],
    [["max_results", "maxResults"], 50],
    // Message bodies are what made one email answer cost two million tokens;
    // headers and the preview are all magic needs.
    [["include_payload", "includePayload"], false],
    [["verbose"], false],
  ]);
  const mail = await readEach(user, tool, connected, args, parseEmails, options);
  return unique(mail, (m) => `${m.threadId}/${m.id}`);
}

// ── Travel ────────────────────────────────────────────────────────────────

/**
 * Live driving (or transit, walking) minutes from Google Routes, with traffic.
 * Undefined without a key or on any failure: the detector then uses the
 * person's own estimate and says it is one.
 */
export async function travelMinutes(
  origin: string,
  destination: string,
  departAt: Date,
  mode: Profile["travelMode"],
  options: MagicOptions = {},
): Promise<number | undefined> {
  const key = options.mapsKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return undefined;
  try {
    const res = await (options.fetch ?? fetch)("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key, "x-goog-fieldmask": "routes.duration" },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        travelMode: mode,
        ...(mode === "DRIVE" || mode === "TWO_WHEELER"
          ? { routingPreference: "TRAFFIC_AWARE", departureTime: new Date(Math.max(departAt.getTime(), Date.now() + MINUTE)).toISOString() }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { routes?: { duration?: string }[] };
    const seconds = Number(/^(\d+(?:\.\d+)?)s$/.exec(body.routes?.[0]?.duration ?? "")?.[1]);
    return Number.isFinite(seconds) ? Math.ceil(seconds / 60) : undefined;
  } catch {
    return undefined;
  }
}

// ── The tick ──────────────────────────────────────────────────────────────

const stale = (at: string | undefined, minutes: number, now: Date) =>
  !at || now.getTime() - new Date(at).getTime() >= minutes * MINUTE - 30_000;

interface Fetched {
  calendar?: MagicState["calendar"];
  inbox?: MagicState["inbox"];
  travel: Record<string, TravelEstimate>;
  health: MagicState["health"];
}

async function refresh(principalId: string, profile: Profile, state: MagicState, now: Date, options: MagicOptions): Promise<Fetched> {
  const out: Fetched = { travel: {}, health: {} };
  const at = now.toISOString();
  if (stale(state.calendar?.at, options.calendarEveryMinutes ?? 15, now)) {
    try {
      out.calendar = { at, events: await fetchCalendar(principalId, now, options) };
      out.health.calendar = undefined;
    } catch (error) {
      out.health.calendar = { at, error: errorText(error) };
    }
  }
  if (stale(state.inbox?.at, options.inboxEveryMinutes ?? 10, now)) {
    try {
      const days = profile.replyLookbackDays;
      const [inbound, sent] = await Promise.all([
        fetchMail(principalId, `in:inbox newer_than:${days}d`, options),
        fetchMail(principalId, `in:sent newer_than:${days}d`, options),
      ]);
      out.inbox = { at, inbound, sent };
      out.health.mail = undefined;
    } catch (error) {
      out.health.mail = { at, error: errorText(error) };
    }
  }

  // Live travel only for in-person events in the next three hours, and at most
  // every fifteen minutes each: a handful of route requests a day per person.
  const events = attendable((out.calendar ?? state.calendar)?.events ?? []);
  for (const e of events) {
    const startsIn = new Date(e.start).getTime() - now.getTime();
    if (startsIn <= 0 || startsIn > 3 * HOUR) continue;
    const key = eventKey(e);
    if (!stale(state.travel[key]?.at, 15, now)) continue;
    const leg = legFor(e, events, profile);
    if (!leg) continue;
    const minutes = await travelMinutes(leg.origin, leg.destination, now, profile.travelMode, options);
    if (minutes !== undefined) out.travel[key] = { minutes, estimated: false, origin: leg.origin, destination: leg.destination, at };
  }
  return out;
}

/**
 * One pass over everyone: read what changed, find moments, gate them, and
 * return what to say to whom. Nothing is sent here; the schedule delivers
 * each dispatch through the person's own conversation.
 *
 * At most once: a moment is recorded as said before it is sent, so a crash or
 * a failed send loses one heads-up rather than repeating it.
 */
export async function tick(options: MagicOptions = {}, now: Date = new Date()): Promise<MagicDispatch[]> {
  const dispatches: MagicDispatch[] = [];
  for (const principalId of people(options)) {
    try {
      const dispatch = await tickPerson(principalId, options, now);
      if (dispatch) dispatches.push(dispatch);
    } catch (error) {
      console.error(`[magic] tick failed for ${personKey(principalId)}: ${errorText(error)}`);
    }
  }
  return dispatches;
}

export async function tickPerson(principalId: string, options: MagicOptions, now: Date): Promise<MagicDispatch | undefined> {
  const surface = readSurface(principalId, options);
  if (!surface) return undefined;
  const stored = readProfile(principalId, options);
  const reminders = readReminders(principalId, options);
  // Off, or not set up yet: reminders the person asked for still arrive.
  const remindersOnly = notReady(stored) !== undefined;
  if (remindersOnly && !reminders.some((r) => r.dueAt <= now.toISOString())) return undefined;
  const profile: Profile = remindersOnly
    ? { ...stored, timeZone: stored.timeZone ?? "UTC", briefAt: null, wrapAt: null }
    : stored;

  const fetched = remindersOnly ? undefined : await refresh(principalId, profile, readState(principalId, options), now, options);

  const statePath = file(options, principalId, "state");
  const dispatch = await exclusive(statePath, () => {
    const state = readState(principalId, options);
    if (fetched) {
      if (fetched.calendar) state.calendar = fetched.calendar;
      if (fetched.inbox) state.inbox = fetched.inbox;
      Object.assign(state.travel, fetched.travel);
      Object.assign(state.health, fetched.health);
    }
    state.lastActiveAt = surface.at;
    const events = remindersOnly ? [] : state.calendar?.events ?? [];
    const selfEmail = surface.auth.attributes?.email;
    const moments = detect({
      profile,
      state,
      now,
      events,
      inbound: remindersOnly ? [] : state.inbox?.inbound ?? [],
      sent: remindersOnly ? [] : state.inbox?.sent ?? [],
      reminders,
      ...(typeof selfEmail === "string" ? { selfEmails: [selfEmail] } : {}),
    }).filter((m) => !remindersOnly || m.kind === "reminder");
    const result = gate(moments, { profile, state, now, inMeeting: Boolean(currentEvent(events, now)) });
    const flushed = digestToFlush(state, result.deliver, now);
    writeJson(statePath, commit(state, result, flushed, profile, now));
    if (!result.deliver.length) return undefined;
    return {
      principalId,
      surface,
      packet: buildPacket(result.deliver, flushed, profile, now),
      moments: result.deliver,
    } satisfies MagicDispatch;
  });

  if (dispatch) {
    const sentReminders = dispatch.moments.filter((m) => m.kind === "reminder").map((m) => m.key.slice("reminder:".length));
    await removeReminders(principalId, sentReminders, options);
  }
  // Expired reminders (more than twelve hours late) are dropped by the gate;
  // take them off the list too.
  const late = reminders.filter((r) => now.getTime() - new Date(r.dueAt).getTime() > 12 * HOUR).map((r) => r.id);
  await removeReminders(principalId, late, options);
  return dispatch;
}

/** What magic knows about one person, for the status tool. */
export function status(principalId: string, options: MagicOptions = {}) {
  const profile = readProfile(principalId, options);
  const state = readState(principalId, options);
  const surface = readSurface(principalId, options);
  return { profile, state, surface, reminders: readReminders(principalId, options), notReady: notReady(profile) };
}
