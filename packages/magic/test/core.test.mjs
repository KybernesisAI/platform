import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFeedback,
  buildPacket,
  commit,
  detect,
  digestToFlush,
  emptyState,
  gate,
  isPhysicalLocation,
  localDate,
  normalizeProfile,
  owedReplies,
  parseCalendarEvents,
  parseEmails,
  updateProfile,
  MAGIC_MARKER,
} from "../dist/index.js";

// Bangkok is UTC+7 with no daylight saving, so local times are easy to read:
// 07:30 local is 00:30Z.
const TZ = "Asia/Bangkok";
const at = (local) => new Date(`2026-10-23T${local}:00+07:00`);
const profile = (extra = {}) => normalizeProfile({ enabled: true, timeZone: TZ, ...extra });

const meeting = (id, startLocal, endLocal, extra = {}) => ({
  id,
  title: `Meeting ${id}`,
  start: at(startLocal).toISOString(),
  end: at(endLocal).toISOString(),
  allDay: false,
  attendees: [{ email: "me@example.com", self: true }, { email: "ana@partner.com", name: "Ana" }],
  ...extra,
});

const base = (overrides = {}) => ({
  profile: profile(),
  state: emptyState(),
  now: at("12:00"),
  events: [],
  inbound: [],
  sent: [],
  reminders: [],
  ...overrides,
});

const kinds = (moments) => moments.map((m) => m.kind).sort();

test("the morning brief comes once, in its window, and not before", () => {
  assert.deepEqual(kinds(detect(base({ now: at("07:00") }))), []);
  const moments = detect(base({ now: at("07:31"), events: [meeting("a", "10:00", "11:00")] }));
  assert.deepEqual(kinds(moments), ["brief"]);
  assert.equal(moments[0].key, "brief:2026-10-23");
  assert.equal(moments[0].evidence.agenda.length, 1);

  const p = profile();
  const g = gate(moments, { profile: p, state: emptyState(), now: at("07:31") });
  assert.equal(g.deliver.length, 1);
  const state = commit(emptyState(), g, [], p, at("07:31"));
  const again = gate(detect(base({ now: at("07:36"), state })), { profile: p, state, now: at("07:36") });
  assert.equal(again.deliver.length, 0, "the ledger stops a second brief");
});

test("meeting prep only for meetings with other people, inside the lead time", () => {
  const solo = meeting("solo", "12:10", "13:00", { attendees: [] });
  const shared = meeting("shared", "12:10", "13:00");
  const later = meeting("later", "13:00", "14:00");
  const moments = detect(base({ events: [solo, shared, later] })).filter((m) => m.kind === "meeting_prep");
  assert.deepEqual(moments.map((m) => m.key), [`prep:shared@${shared.start}`]);
  assert.equal(moments[0].urgency, "soon");
});

test("declined, all-day and free events are not things to be at", () => {
  const events = [
    meeting("declined", "12:05", "13:00", { response: "declined" }),
    meeting("allday", "00:00", "23:59", { allDay: true }),
    meeting("free", "12:05", "13:00", { free: true }),
  ];
  assert.deepEqual(detect(base({ events })), []);
});

test("time to leave uses the person's estimate without live traffic, and says so", () => {
  const p = profile({ places: { office: "1 Office Rd, Bangkok" } });
  const offsite = meeting("off", "15:00", "16:00", { location: "Siam Paragon, Bangkok", attendees: [] });
  // 30 minutes of travel plus a 10 minute buffer: leave by 14:20, said from 14:10.
  assert.deepEqual(detect(base({ profile: p, now: at("14:05"), events: [offsite] })), []);
  const [leave] = detect(base({ profile: p, now: at("14:12"), events: [offsite] }));
  assert.equal(leave.kind, "leave");
  assert.equal(leave.evidence.leaveBy, "14:20");
  assert.equal(leave.evidence.liveTraffic, false);
  assert.equal(leave.evidence.from, "1 Office Rd, Bangkok");
  assert.equal(leave.urgent, false);
  const [late] = detect(base({ profile: p, now: at("14:17"), events: [offsite] }));
  assert.equal(late.urgent, true, "inside five minutes of leaving it is urgent");
});

test("live traffic moves the leave time", () => {
  const p = profile({ places: { office: "1 Office Rd" } });
  const offsite = meeting("off", "15:00", "16:00", { location: "Airport", attendees: [] });
  const state = emptyState();
  state.travel[`off@${offsite.start}`] = { minutes: 70, estimated: false, origin: "1 Office Rd", destination: "Airport", at: at("13:00").toISOString() };
  const [leave] = detect(base({ profile: p, state, now: at("13:35"), events: [offsite] }));
  assert.equal(leave.evidence.leaveBy, "13:40");
  assert.equal(leave.evidence.liveTraffic, true);
});

test("video links and phone numbers are not places to travel to", () => {
  assert.equal(isPhysicalLocation("https://meet.google.com/abc-defg-hij"), false);
  assert.equal(isPhysicalLocation("Zoom"), false);
  assert.equal(isPhysicalLocation("+1 (415) 555-0100"), false);
  assert.equal(isPhysicalLocation("Online"), false);
  assert.equal(isPhysicalLocation("Blue Bottle, 66 Mint St, San Francisco"), true);
});

test("overlapping meetings in the next day are flagged once per pair", () => {
  const a = meeting("a", "16:00", "17:00");
  const b = meeting("b", "16:30", "17:30");
  const conflicts = detect(base({ events: [a, b] })).filter((m) => m.kind === "conflict");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].urgency, "digest", "more than three hours away waits for the brief");
  const close = detect(base({ now: at("14:00"), events: [a, b] })).find((m) => m.kind === "conflict");
  assert.equal(close.urgency, "soon");
});

const mail = (id, from, hoursAgo, extra = {}) => ({
  id,
  threadId: `t-${id}`,
  from,
  subject: `About ${id}`,
  at: new Date(at("12:00").getTime() - hoursAgo * 3_600_000).toISOString(),
  labels: ["INBOX", "IMPORTANT"],
  ...extra,
});

test("replies owed: people who matter, unanswered, old enough, not automated", () => {
  const p = profile({ vips: ["boss@company.com", "bigclient.com"] });
  const inbound = [
    mail("vip", "boss@company.com", 6),
    mail("domain", "cfo@bigclient.com", 5, { labels: ["INBOX"] }),
    mail("important", "friend@example.com", 8),
    mail("fresh", "boss@company.com", 1),
    mail("robot", "no-reply@service.com", 8),
    mail("promo", "deals@shop.com", 8, { labels: ["INBOX", "IMPORTANT", "CATEGORY_PROMOTIONS"] }),
    mail("answered", "peer@example.com", 9),
    mail("plain", "someone@example.com", 9, { labels: ["INBOX"] }),
  ];
  const sent = [{ ...mail("answered-reply", "me@example.com", 2), threadId: "t-answered" }];
  const owed = owedReplies({ profile: p, now: at("12:00"), inbound, sent });
  assert.deepEqual(owed.map((m) => m.id).sort(), ["domain", "important", "vip"]);

  const moments = detect(base({ profile: p, inbound, sent })).filter((m) => m.kind === "reply_owed");
  const urgency = Object.fromEntries(moments.map((m) => [m.evidence.threadId, m.urgency]));
  assert.equal(urgency["t-vip"], "soon");
  assert.equal(urgency["t-important"], "digest");
});

test("fresh mail from a VIP is said while it is fresh", () => {
  const p = profile({ vips: ["boss@company.com"] });
  const inbound = [mail("new", "boss@company.com", 0.2), mail("old", "boss@company.com", 2)];
  const vip = detect(base({ profile: p, inbound })).filter((m) => m.kind === "vip_mail");
  assert.deepEqual(vip.map((m) => m.key), ["vip:new"]);
});

test("quiet hours hold what can wait and let reminders through", () => {
  const p = profile();
  const night = at("23:30");
  const moments = detect(
    base({
      now: night,
      events: [meeting("late", "23:40", "23:59")],
      reminders: [{ id: "r1", text: "Take the pills", dueAt: at("23:25").toISOString(), createdAt: at("09:00").toISOString() }],
    }),
  );
  const g = gate(moments, { profile: p, state: emptyState(), now: night });
  assert.deepEqual(kinds(g.deliver), ["reminder"]);
  assert.deepEqual(kinds(g.held), ["meeting_prep"]);
});

test("a person mid-conversation is not interrupted, unless it is urgent", () => {
  const p = profile();
  const state = { ...emptyState(), lastActiveAt: at("11:59").toISOString() };
  const moments = detect(base({ state, events: [meeting("m", "12:10", "13:00")] }));
  const g = gate(moments, { profile: p, state, now: at("12:00") });
  assert.deepEqual(kinds(g.held), ["meeting_prep"]);
  assert.equal(g.deliver.length, 0);
});

test("in a meeting, prep for the next one waits; leaving does not", () => {
  const p = profile();
  const moments = detect(base({ events: [meeting("next", "12:10", "13:00")] }));
  const g = gate(moments, { profile: p, state: emptyState(), now: at("12:00"), inMeeting: true });
  assert.deepEqual(kinds(g.held), ["meeting_prep"]);
});

test("over the day's budget, interruptions are saved for the brief and flushed with it", () => {
  const p = profile({ dailyBudget: 1 });
  let state = emptyState();
  state.sentByDay[localDate(at("12:00"), TZ)] = 1;
  const moments = detect(base({ events: [meeting("m", "12:10", "13:00")] }));
  const g = gate(moments, { profile: p, state, now: at("12:00") });
  assert.deepEqual(kinds(g.queued), ["meeting_prep"]);
  state = commit(state, g, [], p, at("12:00"));
  assert.equal(state.digest.length, 1);

  // Next morning's brief carries what was saved, if it has not expired.
  const conflictLater = { ...state.digest[0], expiresAt: new Date(at("12:00").getTime() + 2 * 86_400_000).toISOString() };
  state.digest = [conflictLater];
  const morning = new Date(at("07:31").getTime() + 86_400_000);
  const brief = gate(detect(base({ now: morning, state })), { profile: p, state, now: morning });
  assert.deepEqual(kinds(brief.deliver), ["brief"]);
  const flushed = digestToFlush(state, brief.deliver, morning);
  assert.equal(flushed.length, 1);
  const packet = buildPacket(brief.deliver, flushed, p, morning);
  assert.match(packet, /Saved from earlier/);
  assert.equal(commit(state, brief, flushed, p, morning).digest.length, 0);
});

test("the packet says nobody typed it and how to stay quiet", () => {
  const p = profile({ name: "Sam", boldness: "draft" });
  const moments = detect(base({ events: [meeting("m", "12:10", "13:00")] }));
  const packet = buildPacket(moments, [], p, at("12:00"));
  assert.ok(packet.startsWith(MAGIC_MARKER));
  assert.match(packet, /not a message from Sam/);
  assert.match(packet, /call no_reply/);
  assert.match(packet, /never send/);
  assert.match(packet, /Asia\/Bangkok/);
});

test("feedback: off switches a kind off, three misses slow it down", () => {
  const p = profile();
  const off = applyFeedback(p, emptyState(), "meeting_prep", "off");
  assert.equal(off.profile.kinds.meeting_prep.enabled, false);
  const moments = detect(base({ profile: off.profile, events: [meeting("m", "12:10", "13:00")] }));
  assert.deepEqual(kinds(gate(moments, { profile: off.profile, state: emptyState(), now: at("12:00") }).dropped), ["meeting_prep"]);

  let r = { profile: p, state: emptyState() };
  for (let i = 0; i < 3; i++) r = applyFeedback(r.profile, r.state, "reply_owed", "not_useful");
  assert.equal(r.profile.kinds.reply_owed.cooldownMinutes, 240);
  assert.match(r.note, /Three misses/);
});

test("profiles: bad values fall back, partial changes merge", () => {
  const p = normalizeProfile({ timeZone: "Mars/Olympus", dailyBudget: 999, briefAt: "25:00", boldness: "reckless" });
  assert.equal(p.timeZone, null);
  assert.equal(p.dailyBudget, 50);
  assert.equal(p.briefAt, "07:30");
  assert.equal(p.boldness, "suggest");
  assert.equal(p.enabled, false, "off until the person turns it on");

  const q = updateProfile(profile({ places: { home: "Home St" } }), { places: { office: "Office Ave" }, briefAt: null, quietHours: { start: "23:00" } });
  assert.deepEqual(q.places, { home: "Home St", office: "Office Ave" });
  assert.equal(q.briefAt, null);
  assert.deepEqual(q.quietHours, { start: "23:00", end: "07:00" });
  assert.equal(updateProfile(q, { places: { home: null } }).places.home, undefined);
});

test("calendar results are read wherever the connector put them", () => {
  const google = {
    successful: true,
    data: {
      items: [
        { id: "e1", summary: "Standup", start: { dateTime: "2026-10-23T09:00:00+07:00" }, end: { dateTime: "2026-10-23T09:15:00+07:00" }, attendees: [{ email: "Me@Example.com", self: true, responseStatus: "accepted" }] },
        { id: "e2", summary: "Holiday", start: { date: "2026-10-24" }, end: { date: "2026-10-25" } },
        { id: "e3", summary: "Gone", status: "cancelled", start: { dateTime: "2026-10-23T10:00:00Z" }, end: { dateTime: "2026-10-23T11:00:00Z" } },
        { id: "e4", summary: "Focus", transparency: "transparent", location: "https://zoom.us/j/1", start: { dateTime: "2026-10-23T13:00:00Z" }, end: { dateTime: "2026-10-23T14:00:00Z" } },
      ],
    },
  };
  const events = parseCalendarEvents(JSON.stringify({ data: { event_data: google } }));
  assert.deepEqual(events.map((e) => e.id), ["e1", "e4", "e2"]);
  assert.equal(events[0].start, "2026-10-23T02:00:00.000Z");
  assert.equal(events[0].response, "accepted");
  assert.equal(events[0].attendees[0].email, "me@example.com");
  assert.equal(events.find((e) => e.id === "e2").allDay, true);
  assert.equal(events.find((e) => e.id === "e4").free, true);
});

test("mail results are read from the broker's shape and from Gmail's own", () => {
  const broker = {
    data: {
      messages: [
        { messageId: "m1", threadId: "t1", messageTimestamp: "2026-10-23T01:00:00Z", sender: "Ana Ruiz <Ana@Partner.com>", subject: "Contract", labelIds: ["INBOX", "IMPORTANT"], preview: { body: "Can you sign by Friday?" } },
      ],
    },
  };
  const gmail = {
    messages: [
      { id: "m2", threadId: "t2", internalDate: "1761181200000", labelIds: ["SENT"], snippet: "Sure", payload: { headers: [{ name: "From", value: "me@example.com" }, { name: "Subject", value: "Re: Lunch" }] } },
      { id: "m3", threadId: "t3", labelIds: ["INBOX"] },
    ],
  };
  const [m1] = parseEmails(broker);
  assert.equal(m1.from, "ana@partner.com");
  assert.equal(m1.fromName, "Ana Ruiz");
  assert.equal(m1.snippet, "Can you sign by Friday?");
  const parsed = parseEmails(gmail);
  assert.deepEqual(parsed.map((m) => m.id), ["m2"], "a message with no sender or time is skipped, not fatal");
  assert.equal(parsed[0].subject, "Re: Lunch");
});
