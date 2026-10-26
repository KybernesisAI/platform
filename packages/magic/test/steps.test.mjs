import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addReminder,
  argsFor,
  people,
  readReminders,
  readState,
  readSurface,
  recordFeedback,
  recordTurn,
  tick,
  updateSettings,
} from "../dist/steps.js";
import { MAGIC_MARKER } from "../dist/index.js";

const TZ = "Asia/Bangkok";
const at = (local) => new Date(`2026-10-23T${local}:00+07:00`);
const person = { authenticator: "kybernesis", principalId: "usr_1", principalType: "user", subject: "usr_1", attributes: { email: "me@example.com", surface: "linq" } };

function fakeControlPlane({ events = [], inbound = [], sent = [], tools } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/connectors/tools")) {
      return json({
        tools: tools ?? [
          { slug: "GOOGLECALENDAR_EVENTS_LIST", toolkit: "googlecalendar", inputSchema: { properties: { calendarId: {}, timeMin: {}, timeMax: {}, singleEvents: {}, orderBy: {}, maxResults: {} } } },
          { slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail", inputSchema: { properties: { query: {}, max_results: {}, include_payload: {} } } },
        ],
      });
    }
    if (url.endsWith("/api/connectors/execute")) {
      if (body.tool.startsWith("GOOGLECALENDAR")) return json({ result: { data: { items: events } } });
      return json({ result: { data: { messages: body.arguments.query.startsWith("in:sent") ? sent : inbound } } });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetch, calls };
}

const options = (extra = {}) => ({ dir: mkdtempSync(join(tmpdir(), "magic-")), credential: "test-credential", issuer: "https://cp.test", ...extra });

test("the hook records where a person talks, and ignores magic's own turns and non-people", async () => {
  const o = options();
  await recordTurn({ auth: person, channelKind: "chat-sdk", continuationToken: "linq:chat-1", text: "hi", at: at("09:00") }, o);
  await recordTurn({ auth: person, channelKind: "kyb", continuationToken: "studio", text: `${MAGIC_MARKER} check`, at: at("09:05") }, o);
  await recordTurn({ auth: { principalId: "eve:app", principalType: "runtime" }, text: "cron" }, o);
  await recordTurn({ auth: { ...person, attributes: { ...person.attributes, trigger: "routine" } }, channelKind: "kyb", continuationToken: "studio", text: "daily digest", at: at("09:06") }, o);
  assert.deepEqual(people(o), ["usr_1"]);
  const surface = readSurface("usr_1", o);
  assert.equal(surface.token, "linq:chat-1");
  assert.equal(surface.at, at("09:00").toISOString());
  assert.equal(surface.auth.attributes.email, "me@example.com");

  // A delegated turn with no channel keeps the conversation, but counts as activity.
  await recordTurn({ auth: person, text: "subtask", at: at("09:10") }, o);
  assert.equal(readSurface("usr_1", o).token, "linq:chat-1");
  assert.equal(readSurface("usr_1", o).at, at("09:10").toISOString());
  // Writing from Studio moves heads-ups there.
  await recordTurn({ auth: person, channelKind: "eve", text: "from the desktop", at: at("09:20") }, o);
  assert.equal(readSurface("usr_1", o).token, undefined);
  assert.equal(readSurface("usr_1", o).kind, "eve");
});

test("nothing runs for a person who has not turned magic on", async () => {
  const o = options();
  const cp = fakeControlPlane();
  await recordTurn({ auth: person, continuationToken: "linq:chat-1", text: "hi", at: at("06:00") }, o);
  assert.deepEqual(await tick({ ...o, fetch: cp.fetch }, at("07:31")), []);
  assert.equal(cp.calls.length, 0, "no connector is read for someone who is off");
});

test("a reminder still arrives when magic is off, once", async () => {
  const o = options();
  await recordTurn({ auth: person, continuationToken: "linq:chat-1", text: "hi", at: at("06:00") }, o);
  await addReminder("usr_1", "Call the bank", at("10:00"), o);
  assert.deepEqual(await tick(o, at("09:55")), []);
  const [d] = await tick(o, at("10:02"));
  assert.equal(d.moments[0].kind, "reminder");
  assert.match(d.packet, /Call the bank/);
  assert.equal(d.surface.token, "linq:chat-1");
  assert.equal(d.surface.auth.principalId, "usr_1");
  assert.deepEqual(readReminders("usr_1", o), []);
  assert.deepEqual(await tick(o, at("10:07")), []);
});

test("a tick reads calendar and mail as the person, then says the brief once", async () => {
  const o = options();
  const cp = fakeControlPlane({
    events: [{ id: "e1", summary: "Board call", start: { dateTime: "2026-10-23T10:00:00+07:00" }, end: { dateTime: "2026-10-23T11:00:00+07:00" }, attendees: [{ email: "me@example.com", self: true }, { email: "cfo@company.com" }] }],
    inbound: [{ messageId: "m1", threadId: "t1", messageTimestamp: "2026-10-22T20:00:00Z", sender: "Boss <boss@company.com>", subject: "Numbers", labelIds: ["INBOX"] }],
  });
  await recordTurn({ auth: person, continuationToken: "linq:chat-1", text: "turn it on", at: at("06:00") }, o);
  await updateSettings("usr_1", { enabled: true, timeZone: TZ, vips: ["company.com"] }, o);

  const [d] = await tick({ ...o, fetch: cp.fetch }, at("07:31"));
  assert.ok(d, "the brief goes out");
  assert.ok(d.moments.some((m) => m.kind === "brief"));
  assert.match(d.packet, /Board call/);

  const execute = cp.calls.filter((c) => c.url.endsWith("/execute"));
  assert.ok(execute.every((c) => c.body.user === "usr_1"), "connectors are read as the person, never shared");
  const calendar = execute.find((c) => c.body.tool === "GOOGLECALENDAR_EVENTS_LIST");
  assert.equal(calendar.body.arguments.calendarId, "primary");
  const mail = execute.find((c) => c.body.tool === "GMAIL_FETCH_EMAILS");
  assert.equal(mail.body.arguments.include_payload, false, "never fetch message bodies");
  assert.equal(mail.body.arguments.verbose, undefined, "arguments the schema does not name are left out");

  const callsBefore = cp.calls.length;
  assert.deepEqual(await tick({ ...o, fetch: cp.fetch }, at("07:36")), []);
  assert.equal(cp.calls.length, callsBefore, "sources are not re-read before they go stale");
  assert.equal(readState("usr_1", o).sentByDay["2026-10-23"], 1);
});

test("a missing connection is recorded plainly and does not stop the tick", async () => {
  const o = options();
  const cp = fakeControlPlane({ tools: [] });
  await recordTurn({ auth: person, continuationToken: "studio", channelKind: "kyb", text: "hi", at: at("06:00") }, o);
  await updateSettings("usr_1", { enabled: true, timeZone: TZ }, o);
  const [d] = await tick({ ...o, fetch: cp.fetch }, at("07:31"));
  assert.ok(d.moments.some((m) => m.kind === "brief"), "an empty brief still goes, the model can decide it is not worth it");
  const state = readState("usr_1", o);
  assert.match(state.health.calendar.error, /Calendar is not connected/);
  assert.match(state.health.mail.error, /Gmail is not connected/);
});

test("a person with two Gmail accounts gets both inboxes read, not a refusal", async () => {
  const o = options();
  const tools = [{ slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail", inputSchema: { properties: { query: {}, max_results: {}, include_payload: {} } } }];
  const byAccount = {
    acc_work: [{ messageId: "w1", threadId: "tw", messageTimestamp: "2026-10-22T20:00:00Z", sender: "Lead <lead@company.com>", subject: "Work", labelIds: ["INBOX"] }],
    acc_home: [{ messageId: "h1", threadId: "th", messageTimestamp: "2026-10-22T21:00:00Z", sender: "Pal <pal@friends.org>", subject: "Home", labelIds: ["INBOX"] }],
  };
  const calls = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/api/connectors/tools")) {
      return json({ tools, accounts: { GMAIL: [{ id: "acc_work", label: "work" }, { id: "acc_home", label: "home" }] } });
    }
    // The control plane refuses to choose between two accounts of one service.
    if (!body.account) return json({ error: "There are 2 accounts connected for that service (work, home). Say which one to use." }, 409);
    return json({ result: { data: { messages: body.arguments.query.startsWith("in:sent") ? [] : byAccount[body.account] } } });
  };
  await recordTurn({ auth: person, continuationToken: "studio", channelKind: "kyb", text: "hi", at: at("06:00") }, o);
  await updateSettings("usr_1", { enabled: true, timeZone: TZ }, o);
  await tick({ ...o, fetch }, at("07:31"));

  const state = readState("usr_1", o);
  assert.equal(state.health.mail, undefined, "no mail error recorded");
  assert.deepEqual(state.inbox.inbound.map((m) => m.id).sort(), ["h1", "w1"]);
  const reads = calls.filter((c) => c.url.endsWith("/execute"));
  assert.deepEqual([...new Set(reads.map((c) => c.body.account))].sort(), ["acc_home", "acc_work"]);
  assert.ok(reads.every((c) => c.body.user === "usr_1"));
});

test("one account is read without naming it, as before", async () => {
  const o = options();
  const cp = fakeControlPlane();
  await recordTurn({ auth: person, continuationToken: "studio", channelKind: "kyb", text: "hi", at: at("06:00") }, o);
  await updateSettings("usr_1", { enabled: true, timeZone: TZ }, o);
  await tick({ ...o, fetch: cp.fetch }, at("07:31"));
  const reads = cp.calls.filter((c) => c.url.endsWith("/execute"));
  assert.ok(reads.length > 0 && reads.every((c) => c.body.account === undefined));
});

test("feedback is stored per person", async () => {
  const o = options();
  const note = await recordFeedback("usr_1", "conflict", "off", o);
  assert.match(note, /off/);
  const profile = JSON.parse(readFileSync(join(o.dir, "people", "usr_1", "profile.json"), "utf8"));
  assert.equal(profile.kinds.conflict.enabled, false);
});

test("arguments follow the spelling in the tool's schema", () => {
  const camel = { slug: "X", inputSchema: { properties: { timeMin: {} } } };
  const snake = { slug: "X", inputSchema: { properties: { time_min: {} } } };
  const none = { slug: "X" };
  const wanted = [[["timeMin", "time_min"], "t"], [["verbose"], false]];
  assert.deepEqual(argsFor(camel, wanted), { timeMin: "t" });
  assert.deepEqual(argsFor(snake, wanted), { time_min: "t" });
  assert.deepEqual(argsFor(none, wanted), { timeMin: "t", verbose: false });
});

test("live traffic is asked for in-person events only, with the person's places", async () => {
  const o = options({ mapsKey: "maps-key" });
  const cp = fakeControlPlane({
    events: [{ id: "e1", summary: "Lunch", location: "Siam Paragon", start: { dateTime: "2026-10-23T13:00:00+07:00" }, end: { dateTime: "2026-10-23T14:00:00+07:00" } }],
  });
  const routes = [];
  const fetch = async (url, init) => {
    if (String(url).startsWith("https://routes.googleapis.com")) {
      routes.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ routes: [{ duration: "2700s" }] }), { status: 200 });
    }
    return cp.fetch(url, init);
  };
  await recordTurn({ auth: person, continuationToken: "linq:chat-1", text: "hi", at: at("08:00") }, o);
  await updateSettings("usr_1", { enabled: true, timeZone: TZ, briefAt: null, places: { office: "1 Office Rd" } }, o);
  await tick({ ...o, fetch }, at("11:00"));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].origin.address, "1 Office Rd");
  assert.equal(routes[0].destination.address, "Siam Paragon");
  // 45 minutes plus a 10 minute buffer: leave by 12:05, said from 11:55.
  const [d] = await tick({ ...o, fetch }, at("11:56"));
  assert.equal(d.moments[0].kind, "leave");
  assert.equal(d.moments[0].evidence.leaveBy, "12:05");
  assert.equal(d.moments[0].evidence.liveTraffic, true);
});
