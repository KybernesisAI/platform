import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ClientError } from "eve/client";
import { SessionStore } from "../dist/sessions.js";
import {
  answerTurn,
  composeMessage,
  formatInputRequests,
  rejectedTurnReply,
  resolveInputReply,
  respondTurn,
} from "../dist/turn.js";

const imageRef = { url: "https://relay.example/image" };
const image = {
  url: imageRef.url,
  mediaType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
};

function storeWith(id = "session-original", streamIndex = 4) {
  const file = join(mkdtempSync(join(tmpdir(), "buzz-turn-")), "sessions.json");
  const store = new SessionStore(file);
  store.set("relay", "channel", { id, streamIndex });
  return store;
}

function attachedSession(id, send) {
  return {
    state: { sessionId: id, streamIndex: 5 },
    async *stream() {},
    send,
  };
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
          return { result: async () => ({ message: "ok", status: "completed", inputRequests: [] }) };
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
          return { result: async () => ({ message: "continued", status: "completed", inputRequests: [] }) };
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

test("a non-400 stale session error retains the reset-and-create fallback", async () => {
  const store = storeWith();
  const logs = [];
  let createdInput;
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async () => {
          throw new ClientError(404, "session not found");
        });
      },
      async create(input) {
        createdInput = input;
        return {
          response: { result: async () => ({ message: "new reply", status: "completed", inputRequests: [] }) },
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


const requests = [
  {
    requestId: "request-color",
    kind: "question",
    prompt: "Which color?",
    display: "select",
    allowFreeform: false,
    action: { kind: "tool-call", callId: "call-1", toolName: "ask_question", input: {} },
    options: [
      { id: "red-id", label: "Red", description: "Warm" },
      { id: "blue-id", label: "Blue", description: "Cool" },
    ],
  },
];

test("HITL prompts render every option and reply form in plain text", () => {
  const text = formatInputRequests(requests);
  assert.match(text, /Which color\?/);
  assert.match(text, /1\. Red — Warm/);
  assert.match(text, /2\. Blue — Cool/);
  assert.match(text, /number, option name, or option id/);
});

test("pending replies use eve option id, label, and one-based number semantics", () => {
  assert.deepEqual(resolveInputReply("blue-id", requests), [{ requestId: "request-color", optionId: "blue-id" }]);
  assert.deepEqual(resolveInputReply("Blue", requests), [{ requestId: "request-color", optionId: "blue-id" }]);
  assert.deepEqual(resolveInputReply("2", requests), [{ requestId: "request-color", optionId: "blue-id" }]);
  assert.deepEqual(resolveInputReply("not an option", requests), []);
});

test("a parked turn returns requests instead of an empty retry-shaped answer", async () => {
  const store = storeWith();
  const client = {
    sessions: {
      attach(id) {
        return attachedSession(id, async () => ({
          result: async () => ({ message: null, status: "waiting", inputRequests: requests }),
        }));
      },
    },
  };

  const result = await answerTurn(client, store, "channel", "ask", "relay");
  assert.equal(result.status, "waiting");
  assert.deepEqual(result.inputRequests, requests);
  assert.equal(result.message, "");
});

test("respondTurn submits exact input responses with Buzz client context", async () => {
  const store = storeWith();
  let submitted;
  let options;
  const session = {
    state: { sessionId: "session-original", streamIndex: 8 },
    async respond(value, valueOptions) {
      submitted = value;
      options = valueOptions;
      return {
        result: async () => ({ message: "resumed", status: "completed", inputRequests: [] }),
      };
    },
  };
  const client = { sessions: { attach: () => session } };
  const responses = [{ requestId: "request-color", optionId: "blue-id" }];

  const result = await respondTurn(client, store, "channel", responses, "relay");
  assert.deepEqual(submitted, responses);
  assert.deepEqual(options.clientContext, { buzzCommunity: "relay", buzzChannel: "channel" });
  assert.equal(result.message, "resumed");
  assert.equal(store.get("relay", "channel").streamIndex, 8);
});

test("answerTurn refuses to batch a normal message behind persisted pending input", async () => {
  const store = storeWith();
  store.set("relay", "channel", {
    id: "session-original",
    streamIndex: 4,
    pending: requests,
    speaker: "speaker",
  });
  let sent = false;
  let created = false;
  const client = {
    sessions: {
      attach() {
        return attachedSession("session-original", async () => {
          sent = true;
        });
      },
      async create() {
        created = true;
      },
    },
  };

  await assert.rejects(() => answerTurn(client, store, "channel", "do not queue", "relay"), /input is pending/);
  assert.equal(sent, false);
  assert.equal(created, false);
});

test("freeform requests accept text while option-only requests reject it", () => {
  const freeform = [{ ...requests[0], options: undefined, allowFreeform: true }];
  assert.deepEqual(resolveInputReply("my own answer", freeform), [
    { requestId: "request-color", text: "my own answer" },
  ]);
  assert.deepEqual(resolveInputReply("my own answer", requests), []);
});
