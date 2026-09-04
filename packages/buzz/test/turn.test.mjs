import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ClientError } from "eve/client";
import { SessionStore } from "../dist/sessions.js";
import {
  AgentSilenceTimeoutError,
  agentSilenceReply,
  answerTurn,
  composeMessage,
  DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
  rejectedTurnReply,
  validateAgentSilenceTimeoutMs,
} from "../dist/turn.js";

const imageRef = { url: "https://relay.example/image" };
const image = {
  url: imageRef.url,
  mediaType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
};

function emptyStore() {
  const file = join(mkdtempSync(join(tmpdir(), "buzz-turn-")), "sessions.json");
  return new SessionStore(file);
}

function storeWith(id = "session-original", streamIndex = 4) {
  const store = emptyStore();
  store.set("relay", "channel", { id, streamIndex });
  return store;
}

function eventResponse(id, events) {
  return {
    sessionId: id,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function completedEvents(message = "ok") {
  return [
    { type: "message.completed", data: { finishReason: "stop", message } },
    { type: "session.completed", data: {} },
  ];
}

function attachedSession(id, send, stream = async function* () {}) {
  return {
    state: { sessionId: id, streamIndex: 5 },
    stream,
    send,
  };
}

function abortingStall(signal, { clean = false } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => {
        if (clean) resolve();
        else reject(signal.reason);
      }, { once: true }));
    },
  };
}

async function waitFor(predicate) {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

test("a captioned image becomes caption-first text and eve file parts", async () => {
  const message = await composeMessage("look at this", [imageRef], async () => image);

  assert.deepEqual(message[0], { type: "text", text: "look at this" });
  assert.equal(message[1].type, "file");
  assert.equal(message[1].mediaType, "image/png");
  assert.equal(message[1].data, "data:image/png;base64,AQID");
  assert.equal(message.some((part) => part.type === "image"), false);
});

test("an image without a caption still produces a non-empty valid turn", async () => {
  const message = await composeMessage("", [imageRef], async () => image);

  assert.equal(message.length, 1);
  assert.equal(message[0].type, "file");
  assert.equal(message[0].data, "data:image/png;base64,AQID");
});

test("a non-image attachment remains explicitly acknowledged", async () => {
  const message = await composeMessage("please open this", [{ url: "https://relay.example/archive" }], async () => ({
    url: "https://relay.example/archive",
    mediaType: "application/zip",
    bytes: new Uint8Array([9]),
  }));

  assert.equal(message[0].type, "text");
  assert.equal(message[0].text, "please open this");
  assert.equal(message[1].type, "text");
  assert.match(message[1].text, /application\/zip file/);
});

test("a successful image turn and following text turn keep the same session", async () => {
  const store = storeWith();
  const attached = [];
  const sent = [];
  const logs = [];
  const client = {
    sessions: {
      attach(id) {
        attached.push(id);
        return attachedSession(id, async (message) => {
          sent.push(message);
          return eventResponse(id, completedEvents());
        });
      },
      async create() {
        throw new Error("must not replace the existing session");
      },
    },
  };
  const imageMessage = await composeMessage("caption", [imageRef], async () => image);

  await answerTurn(client, store, "channel", imageMessage, "relay", (message) => logs.push(message));
  await answerTurn(client, store, "channel", "follow up", "relay", (message) => logs.push(message));

  assert.deepEqual(attached, ["session-original", "session-original"]);
  assert.equal(sent[0][1].type, "file");
  assert.equal(sent[1], "follow up");
  assert.equal(store.get("relay", "channel").id, "session-original");
  assert.equal(logs.some((message) => message.includes("starting a new one")), false);
});

test("an unread drain stall times out and preserves the existing mapping", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = storeWith();
  let sent = false;
  let created = false;
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async () => {
          sent = true;
          return eventResponse(id, completedEvents());
        }, (_options) => abortingStall(_options.signal, { clean: true }));
      },
      async create() { created = true; },
    },
  };

  const turn = answerTurn(client, store, "channel", "hello", "relay", undefined, 1_000);
  await Promise.resolve();
  t.mock.timers.tick(1_000);

  await assert.rejects(turn, (error) =>
    error instanceof AgentSilenceTimeoutError && error.phase === "unread drain");
  assert.equal(store.get("relay", "channel").id, "session-original");
  assert.equal(store.get("relay", "channel").streamIndex, 4);
  assert.equal(sent, false);
  assert.equal(created, false);
});

test("a send acknowledgement stall is bounded with the same response signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = storeWith();
  let sendSignal;
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async (_message, options) => {
          sendSignal = options.signal;
          return await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
        });
      },
      async create() { assert.fail("must preserve the existing session"); },
    },
  };

  const turn = answerTurn(client, store, "channel", "hello", "relay", undefined, 1_000);
  await waitFor(() => sendSignal);
  t.mock.timers.tick(1_000);

  await assert.rejects(turn, (error) =>
    error instanceof AgentSilenceTimeoutError && error.phase === "send acknowledgement");
  assert.equal(sendSignal.aborted, true);
  assert.equal(store.get("relay", "channel").id, "session-original");
});

test("clean response iterator completion after abort is still reported as timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = storeWith();
  let responseSignal;
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async (_message, options) => {
          responseSignal = options.signal;
          return { sessionId: id, ...abortingStall(options.signal, { clean: true }) };
        });
      },
      async create() { assert.fail("must preserve the existing session"); },
    },
  };

  const turn = answerTurn(client, store, "channel", "hello", "relay", undefined, 1_000, 1_000);
  await waitFor(() => responseSignal);
  t.mock.timers.tick(1_000);

  await assert.rejects(turn, (error) =>
    error instanceof AgentSilenceTimeoutError && error.phase === "response stream");
  assert.equal(store.get("relay", "channel").id, "session-original");
});

test("progress resets inactivity for a turn lasting more than 45 minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = storeWith();
  const pending = [];
  let responseStarted = false;
  const response = {
    sessionId: "session-original",
    async *[Symbol.asyncIterator]() {
      responseStarted = true;
      for (let index = 0; index < 12; index += 1) {
        yield await new Promise((resolve) => pending.push(resolve));
      }
      yield { type: "message.completed", data: { finishReason: "stop", message: "long answer" } };
      yield { type: "session.completed", data: {} };
    },
  };
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async () => response);
      },
    },
  };

  const turn = answerTurn(client, store, "channel", "long work", "relay", undefined, 5 * 60_000);
  await waitFor(() => responseStarted && pending.length > 0);
  for (let index = 0; index < 12; index += 1) {
    t.mock.timers.tick(4 * 60_000);
    pending.shift()({ type: "step.completed", data: { stepIndex: index } });
    await waitFor(() => index === 11 || pending.length > 0);
  }

  assert.equal((await turn).message, "long answer");
});

test("fresh create acknowledgement and response silence are independently bounded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const acknowledgementStore = emptyStore();
  let createSignal;
  const acknowledgementClient = {
    sessions: {
      async create(options) {
        createSignal = options.signal;
        return await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
      },
    },
  };
  const acknowledgement = answerTurn(acknowledgementClient, acknowledgementStore, "channel", "hello", "relay", undefined, 1_000);
  await waitFor(() => createSignal);
  t.mock.timers.tick(1_000);
  await assert.rejects(acknowledgement, (error) =>
    error instanceof AgentSilenceTimeoutError && error.phase === "create acknowledgement");
  assert.equal(acknowledgementStore.get("relay", "channel"), undefined);

  const responseStore = emptyStore();
  let responseSignal;
  const responseClient = {
    sessions: {
      async create(options) {
        responseSignal = options.signal;
        return {
          response: { sessionId: "new", ...abortingStall(options.signal, { clean: true }) },
          session: { state: { sessionId: "new", streamIndex: 0 } },
        };
      },
    },
  };
  const response = answerTurn(responseClient, responseStore, "channel", "hello", "relay", undefined, 1_000, 1_000);
  await waitFor(() => responseSignal);
  t.mock.timers.tick(1_000);
  await assert.rejects(response, (error) =>
    error instanceof AgentSilenceTimeoutError && error.phase === "create response stream");
  assert.equal(responseStore.get("relay", "channel"), undefined);
});

test("generic transport failure preserves the mapping and does not create", async () => {
  const store = storeWith();
  let creates = 0;
  const transport = new Error("socket hang up");
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async () => { throw transport; });
      },
      async create() { creates += 1; },
    },
  };

  await assert.rejects(() => answerTurn(client, store, "channel", "hello", "relay"), transport);
  assert.equal(store.get("relay", "channel").id, "session-original");
  assert.equal(creates, 0);
});

test("HTTP 400 preserves the mapping and the next valid turn uses it", async () => {
  const store = storeWith();
  const attached = [];
  let sends = 0;
  let creates = 0;
  const client = {
    sessions: {
      attach(id) {
        attached.push(id);
        return attachedSession(id, async () => {
          sends += 1;
          if (sends === 1) throw new ClientError(400, "invalid message part");
          return eventResponse(id, completedEvents("continued"));
        });
      },
      async create() {
        creates += 1;
        throw new Error("must not create after request validation fails");
      },
    },
  };

  await assert.rejects(
    () => answerTurn(client, store, "channel", "bad turn", "relay"),
    (error) => error instanceof ClientError && error.status === 400,
  );
  assert.equal(store.get("relay", "channel").id, "session-original");
  assert.equal((await answerTurn(client, store, "channel", "valid turn", "relay")).message, "continued");
  assert.deepEqual(attached, ["session-original", "session-original"]);
  assert.equal(creates, 0);
});

test("an explicit Eve 404 replaces the stale session", async () => {
  const store = storeWith();
  const logs = [];
  let createdInput;
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async () => { throw new ClientError(404, "session not found"); });
      },
      async create(input) {
        createdInput = input;
        return {
          response: eventResponse("session-new", completedEvents("new reply")),
          session: { state: { sessionId: "session-new", streamIndex: 1 } },
        };
      },
    },
  };

  assert.equal(
    (await answerTurn(client, store, "channel", "retry me", "relay", (message) => logs.push(message))).message,
    "new reply",
  );
  assert.equal(createdInput.message, "retry me");
  assert.equal(store.get("relay", "channel").id, "session-new");
  assert.equal(logs.some((message) => message.includes("starting a new one")), true);
});

test("collector preserves final-message, failed, and waiting HITL semantics", async () => {
  const request = {
    action: { callId: "call", input: {}, kind: "tool-call", toolName: "ask_question" },
    kind: "question",
    prompt: "Continue?",
    requestId: "request",
  };
  const store = storeWith();
  const events = [
    { type: "message.completed", data: { finishReason: "tool-calls", message: "not final" } },
    { type: "input.requested", data: { requests: [request] } },
    { type: "message.completed", data: { finishReason: "stop", message: "latest" } },
    { type: "session.waiting", data: {} },
  ];
  const client = { sessions: { attach: (id) => ({
    state: { sessionId: id, streamIndex: 9 },
    async *stream() {},
    async send() { return eventResponse(id, events); },
  }) } };

  assert.deepEqual(await answerTurn(client, store, "channel", "question", "relay"), {
    message: "latest",
    status: "waiting",
    inputRequests: [request],
    sessionId: "session-original",
    streamIndex: 9,
    failures: [],
  });

  const failedStore = storeWith();
  const failedClient = { sessions: { attach: (id) => attachedSession(id, async () =>
    eventResponse(id, [{ type: "session.failed", data: {} }])) } };
  assert.equal((await answerTurn(failedClient, failedStore, "channel", "question", "relay")).status, "failed");
});

test("timeout replies are useful, singular, and do not claim cancellation", () => {
  const error = new AgentSilenceTimeoutError("response stream", 300_000);
  const reply = agentSilenceReply(error);

  assert.match(reply, /agent was silent for too long/i);
  assert.match(reply, /stopped waiting/i);
  assert.match(reply, /kept this conversation/i);
  assert.doesNotMatch(reply, /cancel/i);
  assert.equal(agentSilenceReply(new Error("socket hang up")), null);
});

test("a request rejection becomes words for the room, not a log line", () => {
  const reply = rejectedTurnReply(new ClientError(400, JSON.stringify({ error: "Invalid message part: image" })));

  assert.match(reply, /couldn't read that message/);
  assert.match(reply, /Invalid message part: image/);
});

test("only a 400 is reported as a rejected turn; other failures keep their own path", () => {
  assert.equal(rejectedTurnReply(new ClientError(404, "gone")), null);
  assert.equal(rejectedTurnReply(new Error("socket hang up")), null);
  assert.equal(rejectedTurnReply(undefined), null);
});

test("agent silence configuration has a five-minute default and rejects invalid values", () => {
  assert.equal(DEFAULT_AGENT_SILENCE_TIMEOUT_MS, 300_000);
  assert.equal(validateAgentSilenceTimeoutMs(1), 1);
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateAgentSilenceTimeoutMs(value), /finite positive/);
  }
});

test("a quiet response stream outlives the silence bound while the agent works, up to the work ceiling", async () => {
  // Silence bound 50ms (acknowledgement phases), work ceiling 2s (response
  // stream). The agent acknowledges at once, then says nothing for 300ms
  // while it works, then answers. Before the split this timed out at 50ms.
  const store = storeWith();
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async () => ({
          sessionId: id,
          async *[Symbol.asyncIterator]() {
            await new Promise((r) => setTimeout(r, 300));
            yield* completedEvents("done after a quiet stretch");
          },
        }));
      },
      async create() { throw new Error("must not create"); },
    },
  };
  const result = await answerTurn(client, store, "channel", "long work", "relay", undefined, 50, 2_000);
  assert.equal(result.message, "done after a quiet stretch");
});

test("the work ceiling still bounds a response stream that never speaks again", async (t) => {
  const store = storeWith();
  const client = {
    sessions: {
      attach(id) {
        // A stream that never yields again, but ends when the caller aborts,
        // as the eve client's does.
        return attachedSession(id, async (_message, { signal }) => ({
          sessionId: id,
          async *[Symbol.asyncIterator]() {
            await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
          },
        }));
      },
      async create() { throw new Error("must not create"); },
    },
  };
  await assert.rejects(
    () => answerTurn(client, store, "channel", "long work", "relay", undefined, 10_000, 200),
    (e) => e instanceof AgentSilenceTimeoutError && e.phase === "response stream" && e.intervalMs === 200,
  );
  assert.equal(store.get("relay", "channel").id, "session-original");
});

test("a boundary from an earlier turn does not end this one: the bridge follows the session until its own turn ends", async () => {
  // The send ends a still-running earlier turn. Its session.waiting is the
  // first event on the wire, before this turn's turn.started, and the
  // client's send stream stops there. The bridge must keep following the
  // session and answer from THIS turn.
  const store = storeWith();
  const logs = [];
  const followed = [];
  let cursor = 5;
  const client = {
    sessions: {
      attach(id) {
        return {
          state: { sessionId: id, get streamIndex() { return cursor; } },
          stream: async function* ({ follow, startIndex }) {
            if (!follow) return; // nothing unread before the send
            followed.push(startIndex);
            cursor += 4;
            yield { type: "turn.started", data: { turnId: "turn_9" } };
            yield { type: "message.appended", data: { delta: "work" } };
            yield { type: "message.completed", data: { finishReason: "stop", message: "the real answer" } };
            yield { type: "session.waiting", data: { turnId: "turn_9" } };
          },
          send: async () => ({
            sessionId: id,
            async *[Symbol.asyncIterator]() {
              cursor += 1;
              yield { type: "session.waiting", data: { turnId: "turn_8" } }; // the cancelled earlier turn
            },
          }),
        };
      },
      async create() { throw new Error("must not create"); },
    },
  };
  const result = await answerTurn(client, store, "channel", "again", "relay", (m) => logs.push(m));
  assert.equal(result.message, "the real answer");
  assert.equal(result.status, "waiting");
  assert.deepEqual(followed, [6], "followed from the cursor after the stale boundary");
  assert.equal(store.get("relay", "channel").streamIndex, 10);
  assert.ok(logs.some((m) => m.includes("earlier turn's boundary")));
});

test("a stream that starts this turn and ends at its own boundary needs no continuation", async () => {
  const store = storeWith();
  let followed = 0;
  const client = {
    sessions: {
      attach(id) {
        return {
          state: { sessionId: id, streamIndex: 5 },
          stream: async function* ({ follow }) { if (follow) followed += 1; },
          send: async () => ({
            sessionId: id,
            async *[Symbol.asyncIterator]() {
              yield { type: "turn.started", data: { turnId: "turn_1" } };
              yield { type: "message.completed", data: { finishReason: "stop", message: "direct" } };
              yield { type: "session.waiting", data: { turnId: "turn_1" } };
            },
          }),
        };
      },
      async create() { throw new Error("must not create"); },
    },
  };
  const result = await answerTurn(client, store, "channel", "hi", "relay");
  assert.equal(result.message, "direct");
  assert.equal(followed, 0);
});
