import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ClientError } from "eve/client";

import { SessionStore } from "../dist/sessions.js";
import {
  SessionCoordinator,
  invalidInputReply,
  renderInputRequests,
} from "../dist/turn.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const event = (type, data, id = `${type}-${Math.random()}`) => ({ type, data, meta: { id, at: new Date().toISOString() } });
const nostr = (id, tags = []) => ({ id, pubkey: "a".repeat(64), created_at: 1, kind: 9, tags, content: "", sig: "" });

class EventLog {
  events = [];
  waiters = [];
  emit(value) {
    this.events.push(value);
    for (const wake of this.waiters.splice(0)) wake();
  }
  session(id, calls) {
    let index = 0;
    const thisLog = this;
    return {
      get state() { return { sessionId: id, streamIndex: index }; },
      async *stream({ startIndex = 0, follow = true, signal } = {}) {
        index = startIndex;
        while (true) {
          while (index < thisLog.events.length) {
            const value = thisLog.events[index++];
            yield value;
          }
          if (!follow || signal?.aborted) return;
          await new Promise((resolve) => {
            const wake = () => resolve();
            thisLog.waiters.push(wake);
            signal?.addEventListener("abort", wake, { once: true });
          });
        }
      },
      async send(message) {
        calls.sent.push(message);
        if (calls.sendError) throw calls.sendError;
        return responseWithoutResult();
      },
      async respond(responses) {
        calls.responses.push(responses);
        return responseWithoutResult();
      },
    };
  }
}

function responseWithoutResult() {
  return {
    result() { throw new Error("the initiating response must not own room delivery"); },
    async *[Symbol.asyncIterator]() {},
  };
}

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "buzz-hitl-")), "sessions.json");
  const store = new SessionStore(file);
  store.set("relay", "channel", {
    id: "session-1",
    streamIndex: 0,
    speakerPubkey: "speaker",
    pendingPrompts: [],
    deliveredTurnIds: [],
  });
  const log = new EventLog();
  const calls = { sent: [], responses: [], attaches: 0, sendError: null, creates: 0 };
  const client = {
    sessions: {
      attach(id) {
        calls.attaches += 1;
        return log.session(id, calls);
      },
      async create(input) {
        calls.creates += 1;
        if (!calls.createResult) throw new Error("unexpected create");
        return calls.createResult(input);
      },
    },
  };
  const replies = [];
  let promptSequence = 0;
  const relay = {
    reply(channel, text, replyTo) {
      const posted = nostr(`posted-${++promptSequence}`);
      replies.push({ channel, text, replyTo, posted });
      return posted;
    },
    typingIn() { return () => {}; },
  };
  const coordinator = new SessionCoordinator({
    sessions: store,
    clientFor: () => client,
    relayFor: () => relay,
  });
  return { store, log, calls, replies, coordinator };
}

const approval = {
  kind: "tool-approval",
  requestId: "approval-1",
  prompt: "Approve deleting the branch?",
  display: "confirmation",
  allowFreeform: false,
  action: { kind: "tool-call", callId: "call-1", toolName: "delete", input: { branch: "old" } },
  options: [
    { id: "approve", label: "Approve", description: "Delete it", style: "danger" },
    { id: "cancel", label: "Cancel", description: "Keep it", style: "default" },
  ],
};

const freeform = {
  kind: "question",
  requestId: "question-1",
  prompt: "What name should I use?",
  display: "text",
  allowFreeform: true,
  action: { kind: "tool-call", callId: "call-2", toolName: "ask_question", input: {} },
};

test("generic HITL rendering includes every prompt, option, description, and reply instruction", () => {
  const text = renderInputRequests([
    approval,
    freeform,
    { ...approval, kind: "session-limit", requestId: "limit-1", prompt: "Continue this long session?" },
  ]);
  assert.match(text, /Approve deleting the branch/);
  assert.match(text, /Approve — Delete it \[approve\]/);
  assert.match(text, /What name should I use/);
  assert.match(text, /Continue this long session/);
  assert.match(text, /Reply to this prompt/);
});

test("a visible prompt is persisted and only a reply reference routes text as HITL", async () => {
  const { coordinator, log, store, replies, calls } = setup();
  await coordinator.ensureFollower("relay", "channel", "speaker");
  log.emit(event("turn.started", { sequence: 1, turnId: "turn-1" }));
  log.emit(event("input.requested", { requests: [approval], sequence: 1, stepIndex: 0, turnId: "turn-1" }));
  await tick();

  const prompt = replies[0].posted;
  assert.equal(store.get("relay", "channel").pendingPrompts[0].promptEventId, prompt.id);
  assert.equal(await coordinator.respondToPrompt("relay", "channel", "speaker", "approve", nostr("ordinary")), "ordinary");
  assert.equal(calls.responses.length, 0, "ordinary text is not stolen by a pending approval");

  const invalid = nostr("invalid", [["e", prompt.id]]);
  assert.equal(await coordinator.respondToPrompt("relay", "channel", "speaker", "maybe", invalid), "invalid");
  assert.match(coordinator.correctionFor("relay", "channel", invalid), /Approve/);

  const valid = nostr("valid", [["e", prompt.id]]);
  assert.equal(await coordinator.respondToPrompt("relay", "channel", "speaker", "1", valid), "submitted");
  assert.deepEqual(calls.responses[0], [{ requestId: "approval-1", optionId: "approve" }]);
  coordinator.stop();
});

test("option IDs, labels, indexes, and allowed freeform resolve against the referenced batch", async () => {
  for (const [text, request, expected] of [
    ["approve", approval, { requestId: "approval-1", optionId: "approve" }],
    ["Cancel", approval, { requestId: "approval-1", optionId: "cancel" }],
    ["2", approval, { requestId: "approval-1", optionId: "cancel" }],
    ["Project Atlas", freeform, { requestId: "question-1", text: "Project Atlas" }],
  ]) {
    const { coordinator, log, replies, calls } = setup();
    await coordinator.ensureFollower("relay", "channel", "speaker");
    log.emit(event("turn.started", { sequence: 1, turnId: "turn-1" }));
    log.emit(event("input.requested", { requests: [request], sequence: 1, stepIndex: 0, turnId: "turn-1" }));
    await tick();
    const reply = nostr("answer", [["e", replies[0].posted.id]]);
    assert.equal(await coordinator.respondToPrompt("relay", "channel", "speaker", text, reply), "submitted");
    assert.deepEqual(calls.responses[0], [expected]);
    coordinator.stop();
  }
});

test("input.resolved clears persisted prompt mappings authoritatively", async () => {
  const { coordinator, log, store } = setup();
  await coordinator.ensureFollower("relay", "channel", "speaker");
  log.emit(event("turn.started", { sequence: 1, turnId: "turn-1" }));
  log.emit(event("input.requested", { requests: [approval], sequence: 1, stepIndex: 0, turnId: "turn-1" }));
  await tick();
  assert.equal(store.get("relay", "channel").pendingPrompts.length, 1);
  log.emit(event("input.resolved", {
    resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "approval-1" }],
    sequence: 1,
    stepIndex: 1,
    turnId: "turn-1",
  }));
  await tick();
  assert.equal(store.get("relay", "channel").pendingPrompts.length, 0);
  coordinator.stop();
});

test("the durable follower posts only the final non-empty message and delivers out-of-band resumes", async () => {
  const { coordinator, log, replies } = setup();
  await coordinator.ensureFollower("relay", "channel", "speaker");
  log.emit(event("turn.started", { sequence: 2, turnId: "external-turn" }));
  log.emit(event("message.completed", { message: "intermediate", finishReason: "tool-calls", sequence: 2, stepIndex: 0, turnId: "external-turn" }));
  log.emit(event("message.completed", { message: "final answer", finishReason: "stop", sequence: 2, stepIndex: 1, turnId: "external-turn" }));
  log.emit(event("turn.completed", { sequence: 2, turnId: "external-turn" }));
  await tick();

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "final answer");
  assert.equal(replies[0].replyTo, undefined, "an external continuation must not invent a Buzz reply anchor");
  coordinator.stop();
});

test("local sends keep their Buzz anchor while the initiating response result is never consumed", async () => {
  const { coordinator, log, replies, calls } = setup();
  const asked = nostr("asked");
  await coordinator.submitMessage("relay", "channel", "speaker", "hello", asked);
  log.emit(event("turn.started", { sequence: 1, turnId: "local-turn" }));
  log.emit(event("message.completed", { message: "hello back", finishReason: "stop", sequence: 1, stepIndex: 0, turnId: "local-turn" }));
  log.emit(event("turn.completed", { sequence: 1, turnId: "local-turn" }));
  await tick();

  assert.deepEqual(calls.sent, ["hello"]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].replyTo.id, "asked");
  coordinator.stop();
});

test("one follower is reused per channel and stop ends its typing lifecycle", async () => {
  const { coordinator, log, calls } = setup();
  await coordinator.ensureFollower("relay", "channel", "speaker");
  const attaches = calls.attaches;
  await coordinator.ensureFollower("relay", "channel", "another-speaker");
  assert.equal(calls.attaches, attaches);
  log.emit(event("turn.started", { sequence: 1, turnId: "turn-1" }));
  await tick();
  coordinator.stop();
});

test("HTTP 400 preserves the session mapping", async () => {
  const { coordinator, store, calls } = setup();
  calls.sendError = new ClientError(400, "invalid part");
  await assert.rejects(
    coordinator.submitMessage("relay", "channel", "speaker", "bad", nostr("bad")),
    (error) => error instanceof ClientError && error.status === 400,
  );
  assert.equal(store.get("relay", "channel").id, "session-1");
  assert.equal(calls.creates, 0);
  coordinator.stop();
});

test("a non-400 stale session aborts the old follower and creates a replacement", async () => {
  const { coordinator, store, calls, log } = setup();
  calls.sendError = new ClientError(404, "gone");
  calls.createResult = () => {
    calls.sendError = null;
    return {
      session: { state: { sessionId: "session-2", streamIndex: 0 } },
      response: responseWithoutResult(),
    };
  };
  await coordinator.submitMessage("relay", "channel", "speaker", "retry", nostr("retry"));
  assert.equal(store.get("relay", "channel").id, "session-2");
  assert.equal(calls.creates, 1);
  log.emit(event("turn.started", { sequence: 1, turnId: "replacement" }));
  coordinator.stop();
});

test("pending prompts survive a SessionStore restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "buzz-pending-")), "sessions.json");
  const first = new SessionStore(file);
  first.set("relay", "channel", {
    id: "session-1",
    streamIndex: 8,
    pendingPrompts: [{ promptEventId: "prompt-1", requests: [approval] }],
    deliveredTurnIds: [],
  });
  const second = new SessionStore(file);
  assert.equal(second.get("relay", "channel").pendingPrompts[0].requests[0].requestId, "approval-1");
});

test("invalid guidance does not invent options for a freeform-only request", () => {
  assert.match(invalidInputReply([freeform]), /non-empty written answer/);
});
