import assert from "node:assert/strict";
import { after, test } from "node:test";

import { BuzzRelay, KIND_MESSAGE, KIND_PRESENCE, KIND_REACTION, KIND_TYPING } from "../dist/relay.js";
import { loadOrCreateKey } from "../dist/keys.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const keyFile = join(mkdtempSync(join(tmpdir(), "buzz-relay-")), "agent.json");
const { key } = loadOrCreateKey(keyFile);

/** A WebSocket stand-in: records what was sent, lets a test push frames back. */
class FakeSocket {
  static last = null;
  static OPEN = 1;
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.listeners = {};
    FakeSocket.last = this;
  }
  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  emit(type, event) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
  deliver(frame) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  /** Every EVENT frame this socket was asked to publish. */
  published(kind) {
    return this.sent.filter((f) => f[0] === "EVENT" && f[1].kind === kind).map((f) => f[1]);
  }
}

/** Every relay a test opened, so the timers that keep a daemon alive do not keep the run alive. */
const opened = [];
after(() => {
  for (const relay of opened) relay.close();
});

function connected(onMessage = () => {}) {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const relay = new BuzzRelay({ url: "wss://relay.example.com", key, onMessage });
  relay.connect();
  const socket = FakeSocket.last;
  globalThis.WebSocket = previous;
  opened.push(relay);
  return { relay, socket };
}

/** Authenticate, which is what unlocks presence and polling. */
function authenticate(socket) {
  socket.deliver(["AUTH", "challenge-123"]);
  socket.deliver(["OK", "any-id", true, ""]);
}

test("a challenge is answered with a signed event naming the relay and the challenge", () => {
  const { socket } = connected();
  socket.deliver(["AUTH", "challenge-123"]);

  const auth = socket.sent.find((f) => f[0] === "AUTH");
  assert.ok(auth, "the relay must be answered");
  assert.equal(auth[1].kind, 22242);
  assert.equal(auth[1].pubkey, key.publicKey);
  const tags = Object.fromEntries(auth[1].tags);
  assert.equal(tags.relay, "wss://relay.example.com");
  assert.equal(tags.challenge, "challenge-123");
});

test("presence goes out on sign-in, so the agent does not look offline between sentences", () => {
  const { socket } = connected();
  authenticate(socket);

  const presence = socket.published(KIND_PRESENCE);
  assert.equal(presence.length, 1);
  assert.equal(presence[0].content, "online");
  assert.deepEqual(presence[0].tags, []);
});

test("a poll asks only for messages addressed to this agent, and closes on delivery", () => {
  const { socket } = connected();
  authenticate(socket);

  const req = socket.sent.find((f) => f[0] === "REQ");
  assert.ok(req);
  assert.deepEqual(req[2].kinds, [KIND_MESSAGE]);
  assert.deepEqual(req[2]["#p"], [key.publicKey]);

  socket.deliver(["EOSE", req[1]]);
  const close = socket.sent.find((f) => f[0] === "CLOSE");
  assert.ok(close, "a subscription left open eats the relay's per-connection limit");
  assert.equal(close[1], req[1]);
});

test("the agent never answers itself, and never answers the same message twice", () => {
  const seen = [];
  const { socket } = connected((event) => seen.push(event.id));
  authenticate(socket);

  const fromSelf = { id: "a", pubkey: key.publicKey, created_at: 1, kind: 9, tags: [], content: "hi", sig: "" };
  const fromOther = { id: "b", pubkey: "f".repeat(64), created_at: 1, kind: 9, tags: [], content: "hi", sig: "" };

  socket.deliver(["EVENT", "sub", fromSelf]);
  socket.deliver(["EVENT", "sub", fromOther]);
  socket.deliver(["EVENT", "sub", fromOther]);

  assert.deepEqual(seen, ["b"], "own events are noise; redelivery is not a second question");
});

test("typing is scoped to its channel and stops when told", () => {
  const { relay, socket } = connected();
  authenticate(socket);

  const stop = relay.typingIn("channel-1");
  const typing = socket.published(KIND_TYPING);
  assert.equal(typing.length, 1);
  assert.equal(typing[0].content, "");
  assert.deepEqual(typing[0].tags, [["h", "channel-1"]]);
  stop();
});

test("a reply is anchored to the message it answers and addressed back to its author", () => {
  const { relay, socket } = connected();
  authenticate(socket);

  const asked = { id: "msg-1", pubkey: "a".repeat(64), created_at: 1, kind: 9, tags: [], content: "?", sig: "" };
  relay.reply("channel-1", "an answer", asked);

  const message = socket.published(KIND_MESSAGE).at(-1);
  assert.equal(message.content, "an answer");
  assert.deepEqual(message.tags, [["h", "channel-1"], ["e", "msg-1"], ["p", "a".repeat(64)]]);
});

test("a reaction is signed, sent over HTTP, and binds the signature to the body", async () => {
  const { relay, socket } = connected();
  authenticate(socket);

  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ accepted: true, message: "" }) };
  };

  await relay.react("msg-1", "👀");
  globalThis.fetch = previousFetch;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example.com/events");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.kind, KIND_REACTION);
  assert.equal(body.content, "👀");
  assert.deepEqual(body.tags, [["e", "msg-1"]]);

  const header = calls[0].init.headers.authorization;
  assert.match(header, /^Nostr /);
  const auth = JSON.parse(Buffer.from(header.slice(6), "base64").toString());
  assert.equal(auth.kind, 27235);
  const tags = Object.fromEntries(auth.tags);
  assert.equal(tags.u, "https://relay.example.com/events");
  assert.equal(tags.method, "POST");
  const { createHash } = await import("node:crypto");
  assert.equal(tags.payload, createHash("sha256").update(calls[0].init.body).digest("hex"));

  assert.equal(
    socket.published(KIND_REACTION).length,
    0,
    "a reaction published on the socket is accepted and then does not appear",
  );
});

test("opening a direct conversation answers with the channel it created", async () => {
  const { relay, socket } = connected();
  authenticate(socket);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ accepted: true, message: JSON.stringify({ channel_id: "dm-42" }) }),
  });
  const channel = await relay.openDirectMessage("b".repeat(64));
  assert.equal(channel, "dm-42");

  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "denied" });
  assert.equal(await relay.openDirectMessage("b".repeat(64)), null, "a refusal must not look like a channel");
  globalThis.fetch = previousFetch;
});

test("stopping says goodbye rather than letting presence lapse", () => {
  const { relay, socket } = connected();
  authenticate(socket);
  relay.setPresence("offline");
  assert.equal(socket.published(KIND_PRESENCE).at(-1).content, "offline");
  relay.close();
});
