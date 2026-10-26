import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_OWNER,
  captureRunEvent,
  exchangesFrom,
  newRunCapture,
  noteSession,
  pendingContext,
  readThread,
  recapContext,
  runAddress,
  threadAddress,
  threadOwnerOf,
  threadRoutes,
  updateThread,
  writeThread,
} from "../dist/index.js";

const dir = () => mkdtempSync(join(tmpdir(), "kyb-thread-"));

const report = (over = {}) => ({
  id: `r${Math.random()}`,
  kind: "report",
  routine: "daily-calendar",
  text: "Two meetings today.",
  at: "2026-10-26T07:00:00.000Z",
  runSessionId: "run_1",
  ...over,
});

test("each person has one fixed address, and every run its own", () => {
  assert.equal(threadAddress("user_dana"), "thread:user_dana");
  const a = runAddress("daily-calendar", "user_dana", 1_000);
  const b = runAddress("daily-calendar", "user_dana", 2_000);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("run:daily-calendar:user_dana:"));
});

test("only a person gets a thread: the app principal and missing ids do not", () => {
  assert.equal(threadOwnerOf({ principalType: "user", principalId: "user_dana" }), "user_dana");
  assert.equal(threadOwnerOf({ principalType: "user", principalId: "eve:app" }), undefined);
  assert.equal(threadOwnerOf({ principalType: "service", principalId: "user_dana" }), undefined);
  assert.equal(threadOwnerOf({ principalType: "user", principalId: "" }), undefined);
  assert.equal(threadOwnerOf(undefined), undefined);
  assert.equal(AGENT_OWNER, "_agent");
});

test("the record survives a round trip and keeps people apart", () => {
  const d = dir();
  const dana = readThread(d, "user_dana");
  assert.deepEqual(dana, { owner: "user_dana", sessions: [], reports: [] });
  assert.equal(noteSession(dana, "s1", "2026-10-01T00:00:00.000Z"), true);
  assert.equal(noteSession(dana, "s1"), false, "a known session is not added twice");
  dana.reports.push(report());
  writeThread(d, dana);
  assert.deepEqual(readThread(d, "user_dana").sessions, [{ id: "s1", at: "2026-10-01T00:00:00.000Z" }]);
  assert.equal(readThread(d, "user_dana").reports.length, 1);
  assert.deepEqual(readThread(d, "user_sam").reports, []);
  updateThread(d, "user_dana", (r) => (r.fresh = ["2026-10-02T00:00:00.000Z"]));
  assert.deepEqual(readThread(d, "user_dana").fresh, ["2026-10-02T00:00:00.000Z"]);
});

test("an owner id cannot reach outside the threads folder", () => {
  const d = dir();
  writeThread(d, { owner: "../escape", sessions: [], reports: [report()] });
  assert.equal(readThread(d, "../escape").reports.length, 1);
  assert.deepEqual(readThread(join(d, ".."), "escape").reports, []);
});

test("untold reports go to the model once, newest last, and questions never do", () => {
  const record = {
    owner: "user_dana",
    sessions: [],
    reports: [
      report({ text: "old", told: true }),
      report({ text: "Morning brief.", cards: [{ card: "artifact", title: "Daily calendar", data: { artifactId: "art_9" } }] }),
      report({ kind: "question", text: "Send it?" }),
      report({ routine: "magic", text: "Your 3pm moved." }),
    ],
  };
  const context = pendingContext(record);
  assert.match(context, /did not write them/);
  assert.match(context, /routine "daily-calendar": Morning brief\. \[artifact "Daily calendar" \(artifact art_9\)\]/);
  assert.match(context, /heads-up: Your 3pm moved\./);
  assert.doesNotMatch(context, /: old|Send it/);
  assert.ok(context.indexOf("Morning brief") < context.indexOf("3pm"));
  assert.equal(pendingContext(record), undefined, "told once");
});

test("a long report is cut short in context", () => {
  const context = pendingContext({ owner: "u", sessions: [], reports: [report({ text: "x".repeat(2_000) })] });
  assert.ok(context.length < 1_000);
  assert.match(context, /…/);
});

test("the recap carries the end of the previous session", () => {
  const events = [
    { type: "message.received", data: { message: "Book the dentist" } },
    { type: "message.completed", data: { message: "", finishReason: "tool-calls" } },
    { type: "message.completed", data: { message: "Booked for Tuesday.", finishReason: "stop" } },
    { type: "session.waiting", data: {} },
  ];
  const exchanges = exchangesFrom(events);
  assert.deepEqual(exchanges, [
    { role: "person", text: "Book the dentist" },
    { role: "agent", text: "Booked for Tuesday." },
  ]);
  assert.equal(recapContext(exchanges), "This conversation continues from an earlier session. The last exchanges were:\nPerson: Book the dentist\nYou: Booked for Tuesday.");
  assert.equal(recapContext([]), undefined);
});

test("a run's report is its final answer, not a step on the way", () => {
  const capture = newRunCapture();
  captureRunEvent(capture, "message.completed", { message: "Looking at your calendar.", finishReason: "tool-calls" });
  assert.equal(capture.text, undefined);
  captureRunEvent(capture, "message.completed", { message: "Two meetings today.", finishReason: "stop" });
  assert.equal(capture.text, "Two meetings today.");
});

// The routes, driven with eve's route context faked: what matters is who the
// owner is (always the verified caller) and what reaches eve.
function routes(d, userId = "user_dana", earlier = {}) {
  const list = threadRoutes({
    prefix: "/eve/v1/kyb",
    dir: d,
    issuer: "https://cp.example",
    identify: async () => ({ userId, level: "use", org: "org_1" }),
    readExchanges: async (id) => earlier[id] ?? [],
  });
  const find = (method, path) => list.find((r) => r.method === method && r.path === `/eve/v1/kyb${path}`);
  return { find };
}

function fakeEve(live = {}) {
  const sent = [];
  const responded = [];
  return {
    sent,
    responded,
    ctx: {
      params: {},
      resolveSession: async (address) => (live[address] ? { id: live[address] } : undefined),
      from: (address) => ({
        send: async (message, options) => {
          sent.push({ address, message, options });
          live[address] ??= `s_${sent.length}`;
          return { id: live[address] };
        },
        respond: async (responses, options) => {
          responded.push({ address, responses, options });
          return { id: live[address] };
        },
        cancel: async () => ({ ok: true }),
        clear: async () => ({ ok: true }),
      }),
      attachSession: (id) => ({
        respond: async (responses, options) => {
          responded.push({ session: id, responses, options });
          return { status: "accepted", sessionId: id };
        },
      }),
    },
  };
}

const post = (body, headers = {}) =>
  new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("a message goes to the caller's own address, as the caller, with their reports as context", async () => {
  const d = dir();
  updateThread(d, "user_dana", (r) => r.reports.push(report()));
  const eve = fakeEve();
  const { find } = routes(d);
  const res = await find("POST", "/thread/messages").handler(post({ message: "move my 3pm" }, { "x-kybernesis-surface": "phone" }), eve.ctx);
  assert.equal(res.status, 200);
  const [send] = eve.sent;
  assert.equal(send.address, "thread:user_dana");
  assert.equal(send.options.auth.principalId, "user_dana");
  assert.equal(send.options.auth.principalType, "user");
  assert.equal(send.options.auth.attributes.surface, "phone");
  assert.deepEqual(send.options.state, { kind: "thread", owner: "user_dana" });
  assert.match(send.options.context.join("\n"), /Two meetings today/);
  assert.deepEqual(readThread(d, "user_dana").sessions.map((s) => s.id), ["s_1"]);

  await find("POST", "/thread/messages").handler(post({ message: "thanks" }), eve.ctx);
  assert.equal(eve.sent[1].options.context, undefined, "reports are told once");
  assert.deepEqual(readThread(d, "user_dana").sessions.map((s) => s.id), ["s_1"], "same session, not a new one");
});

test("the client's own context rides along, cut to size", async () => {
  const eve = fakeEve();
  await routes(dir()).find("POST", "/thread/messages").handler(post({ message: "hi", clientContext: "x".repeat(20_000) }), eve.ctx);
  assert.equal(eve.sent[0].options.context.length, 1);
  assert.equal(eve.sent[0].options.context[0].length, 8_000);
});

test("an empty message is refused", async () => {
  const eve = fakeEve();
  const res = await routes(dir()).find("POST", "/thread/messages").handler(post({ message: "  " }), eve.ctx);
  assert.equal(res.status, 400);
  assert.equal(eve.sent.length, 0);
});

test("when the thread moves to a new session the end of the old one rides along", async () => {
  const d = dir();
  updateThread(d, "user_dana", (r) => noteSession(r, "s_old", "2026-09-01T00:00:00.000Z"));
  const earlier = { s_old: [{ role: "person", text: "Book the dentist" }, { role: "agent", text: "Booked for Tuesday." }] };
  const eve = fakeEve();
  await routes(d, "user_dana", earlier).find("POST", "/thread/messages").handler(post({ message: "and the next one?" }), eve.ctx);
  assert.match(eve.sent[0].options.context.join("\n"), /continues from an earlier session[\s\S]*Booked for Tuesday/);
  assert.deepEqual(readThread(d, "user_dana").sessions.map((s) => s.id), ["s_old", "s_1"]);

  // After Start fresh, a new session starts clean: no recap.
  updateThread(d, "user_dana", (r) => (r.fresh = [new Date(Date.now() + 1_000).toISOString()]));
  const next = fakeEve();
  await routes(d, "user_dana", { s_1: earlier.s_old }).find("POST", "/thread/messages").handler(post({ message: "hi" }), next.ctx);
  assert.equal(next.sent[0].options.context, undefined);
});

test("the thread lists its sessions and reports, only the caller's", async () => {
  const d = dir();
  updateThread(d, "user_dana", (r) => r.reports.push(report()));
  updateThread(d, "user_sam", (r) => r.reports.push(report({ text: "Sam's" })));
  const eve = fakeEve({ "thread:user_dana": "s_live" });
  const res = await routes(d).find("GET", "/thread").handler(new Request("http://x/eve/v1/kyb/thread"), eve.ctx);
  const body = await res.json();
  assert.equal(body.current, "s_live");
  assert.deepEqual(body.sessions.map((s) => s.id), ["s_live"]);
  assert.deepEqual(body.reports.map((r) => r.text), ["Two meetings today."]);
});

test("a background run's question can be answered only by the person it reported to", async () => {
  const d = dir();
  updateThread(d, "user_dana", (r) => r.reports.push(report({ kind: "question", runSessionId: "run_q", text: "Send it?" })));
  const answer = post({ sessionId: "run_q", inputResponses: [{ requestId: "req_1", optionId: "approve" }] });

  const sam = fakeEve();
  const refused = await routes(d, "user_sam").find("POST", "/thread/respond").handler(answer.clone(), sam.ctx);
  assert.equal(refused.status, 404);
  assert.equal(sam.responded.length, 0);

  const dana = fakeEve();
  const ok = await routes(d).find("POST", "/thread/respond").handler(answer, dana.ctx);
  assert.equal(ok.status, 200);
  assert.equal(dana.responded[0].session, "run_q");
  assert.equal(dana.responded[0].options.auth.principalId, "user_dana");
  assert.equal(readThread(d, "user_dana").reports[0].settled, true);
});

test("start fresh clears the agent's context and marks reports told", async () => {
  const d = dir();
  updateThread(d, "user_dana", (r) => r.reports.push(report()));
  const eve = fakeEve();
  const res = await routes(d).find("POST", "/thread/fresh").handler(post({}), eve.ctx);
  assert.equal(res.status, 200);
  const record = readThread(d, "user_dana");
  assert.equal(record.fresh.length, 1);
  assert.equal(record.reports[0].told, true);
});
