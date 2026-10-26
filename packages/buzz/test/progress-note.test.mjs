import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { SessionStore } from "../dist/sessions.js";
import { answerTurn } from "../dist/turn.js";

function storeWith() {
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), "buzz-progress-")), "sessions.json"));
  store.set("relay", "channel", { id: "s1", streamIndex: 4 });
  return store;
}

const note = (callId, message, turnId = "t1") => ({
  type: "actions.requested",
  data: { turnId, actions: [{ callId, kind: "tool-call", toolName: "notify__working_on_it", input: { message } }] },
});

function clientStreaming(events) {
  return {
    sessions: {
      attach(id) {
        return {
          state: { sessionId: id, streamIndex: 5 },
          async *stream() {},
          async send() {
            return {
              sessionId: id,
              async *[Symbol.asyncIterator]() {
                yield* events;
              },
            };
          },
        };
      },
      async create() {
        throw new Error("must continue the existing session");
      },
    },
  };
}

const run = (events, notes, logs = [], notesPerTurn) =>
  answerTurn(clientStreaming(events), storeWith(), "channel", "make me a page", "relay", (line) => logs.push(line), 60_000, 60_000, 1_000, (text) =>
    notes.push(text), notesPerTurn,
  );

test("a long job's note is posted while the turn runs, once, and the answer stays the reply", async () => {
  const notes = [];
  let postedBeforeAnswer = false;
  const events = [
    { type: "turn.started", data: { turnId: "t1" } },
    note("c1", "On it. Building your daily calendar page now."),
    {
      type: "action.result",
      data: { turnId: "t1", status: "completed", result: { callId: "c1", toolName: "notify__working_on_it", output: { sent: true, message: "On it. Building your daily calendar page now." } } },
    },
    note("c2", "Still on it."),
    {
      type: "message.completed",
      get data() {
        postedBeforeAnswer = notes.length === 1;
        return { finishReason: "stop", message: "Here is your calendar page." };
      },
    },
    { type: "session.waiting", data: {} },
  ];
  const result = await run(events, notes);
  assert.deepEqual(notes, ["On it. Building your daily calendar page now."]);
  assert.equal(postedBeforeAnswer, true);
  assert.equal(result.message, "Here is your calendar page.");
});

test("default logs the dropped call; raised caps post in order and collapse requested/result", async () => {
  const events = [
    { type: "turn.started", data: { turnId: "t1" } },
    note("c1", "First."),
    { type: "action.result", data: { turnId: "t1", status: "completed", result: { callId: "c1", toolName: "notify__working_on_it", output: { message: "First." } } } },
    note("c2", "Second."),
    note("c3", "Third."),
    { type: "message.completed", data: { finishReason: "stop", message: "Final reply." } },
    { type: "session.waiting", data: {} },
  ];
  const notes = [], logs = [];
  assert.equal((await run(events, notes, logs)).message, "Final reply.");
  assert.deepEqual(notes, ["First."]);
  assert.ok(logs.some((line) => line.includes("[debug]") && line.includes("callId=c2") && line.includes("turn-limit")));
  const raised = [], raisedLogs = [];
  assert.equal((await run(events, raised, raisedLogs, 3)).message, "Final reply.");
  assert.deepEqual(raised, ["First.", "Second.", "Third."]);
  assert.ok(raisedLogs.some((line) => line.includes("callId=c1") && line.includes("duplicate-call")));
  const single = [];
  await run([events[0], events[1], events[2], ...events.slice(-2)], single, [], "unlimited");
  assert.deepEqual(single, ["First."]);
});

test("a quick answer posts no note", async () => {
  const notes = [];
  await run(
    [
      { type: "turn.started", data: { turnId: "t1" } },
      { type: "message.completed", data: { finishReason: "stop", message: "391." } },
      { type: "session.waiting", data: {} },
    ],
    notes,
  );
  assert.deepEqual(notes, []);
});

test("an earlier turn's note on the stream's tail is not this turn's", async () => {
  const notes = [];
  await run(
    [
      { type: "session.waiting", data: {} },
      note("c0", "On it. The old job.", "t0"),
      { type: "turn.started", data: { turnId: "t1" } },
      note("c1", "On it. The new job."),
      { type: "message.completed", data: { finishReason: "stop", message: "Done." } },
      { type: "session.waiting", data: {} },
    ],
    notes,
  );
  assert.deepEqual(notes, ["On it. The new job."]);
});

test("a listener that throws never fails the turn", async () => {
  const result = await answerTurn(
    clientStreaming([
      { type: "turn.started", data: { turnId: "t1" } },
      note("c1", "On it."),
      { type: "message.completed", data: { finishReason: "stop", message: "Done." } },
      { type: "session.waiting", data: {} },
    ]),
    storeWith(),
    "channel",
    "go",
    "relay",
    () => {},
    60_000,
    60_000,
    1_000,
    () => {
      throw new Error("relay closed");
    },
  );
  assert.equal(result.message, "Done.");
});

test("CLI rejects invalid turn caps before starting a bridge and advertises the setting", () => {
  const cli = new URL("../dist/cli.js", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /BUZZ_PROGRESS_PER_TURN/);
  for (const value of ["0", "2.5", "garbage", "9007199254740992"]) {
    const run = spawnSync(process.execPath, [cli.pathname, "run"], {
      encoding: "utf8",
      env: { ...process.env, BUZZ_PROGRESS_PER_TURN: value },
      timeout: 10_000,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /BUZZ_PROGRESS_PER_TURN must be a positive safe integer/);
  }
});
