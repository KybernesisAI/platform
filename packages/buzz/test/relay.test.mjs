import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  BuzzRelay,
  KIND_MESSAGE,
  KIND_PRESENCE,
  KIND_REACTION,
  KIND_TYPING,
  MAX_SEEN_EVENT_IDS,
} from "../dist/relay.js";
import { loadOrCreateKey } from "../dist/keys.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const keyFile = join(mkdtempSync(join(tmpdir(), "buzz-relay-")), "agent.json");
const { key } = loadOrCreateKey(keyFile);

/** The relay's own key, as its information document (NIP-11 `self`) names it. */
const RELAY_SELF = "e".repeat(64);
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ self: RELAY_SELF }), { status: 200 });
after(() => {
  globalThis.fetch = realFetch;
});

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

function connected(onMessage = () => {}, options = {}) {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const relay = new BuzzRelay({ url: "wss://relay.example.com", key, onMessage, ...options });
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

test("polling keeps the latest second inclusive so messages sharing a timestamp are not skipped", async () => {
  const received = [];
  const { relay, socket } = connected((event) => received.push(event.id), { pollMs: 5 });
  authenticate(socket);

  const createdAt = Math.floor(Date.now() / 1000);
  socket.deliver(["EVENT", "sub", {
    id: "same-second-a",
    pubkey: "f".repeat(64),
    created_at: createdAt,
    kind: 9,
    tags: [],
    content: "first",
    sig: "",
  }]);
  await new Promise((resolve) => setTimeout(resolve, 12));

  const polls = socket.sent.filter((frame) => frame[0] === "REQ");
  assert.equal(polls.at(-1)[2].since, createdAt);
  relay.close();
});

test("disconnect stops the old polling loop before reconnecting", async () => {
  const { relay, socket } = connected(() => {}, { pollMs: 5 });
  authenticate(socket);
  await new Promise((resolve) => setTimeout(resolve, 12));
  socket.emit("close");
  const pollsAtDisconnect = socket.sent.filter((frame) => frame[0] === "REQ").length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(
    socket.sent.filter((frame) => frame[0] === "REQ").length,
    pollsAtDisconnect,
  );
  relay.close();
});

test("redelivery memory is bounded for a long-running bridge", () => {
  const received = [];
  const { relay, socket } = connected((event) => received.push(event.id));
  authenticate(socket);
  const createdAt = Math.floor(Date.now() / 1000);

  for (let index = 0; index <= MAX_SEEN_EVENT_IDS; index += 1) {
    socket.deliver(["EVENT", "sub", {
      id: `event-${index}`,
      pubkey: "f".repeat(64),
      created_at: createdAt,
      kind: 9,
      tags: [],
      content: "message",
      sig: "",
    }]);
  }
  socket.deliver(["EVENT", "sub", {
    id: "event-0",
    pubkey: "f".repeat(64),
    created_at: createdAt,
    kind: 9,
    tags: [],
    content: "message",
    sig: "",
  }]);

  assert.equal(received.length, MAX_SEEN_EVENT_IDS + 2);
  relay.close();
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

test("reply returns the published event id, or null when no socket is connected", () => {
  const offline = new BuzzRelay({ url: "wss://relay.example.com", key, onMessage: () => {} });
  opened.push(offline);
  assert.equal(offline.reply("channel-1", "not sent"), null);

  const { relay, socket } = connected();
  authenticate(socket);
  const id = relay.reply("channel-1", "sent");
  const published = socket.published(KIND_MESSAGE).at(-1);
  assert.equal(published.content, "sent");
  assert.equal(id, published.id);
});

test("watched prompts add a reply filter to the poll, so an answer needs no mention", () => {
  const { relay, socket } = connected();
  authenticate(socket);
  const before = socket.sent.filter((frame) => frame[0] === "REQ").at(-1);
  assert.equal(before.length, 3, "one filter before any prompt is watched");

  relay.watchReplies(["prompt-1"]);
  socket.sent.length = 0;
  relay.poll();
  const req = socket.sent.filter((frame) => frame[0] === "REQ").at(-1);
  assert.equal(req.length, 4, "a second filter once a prompt is watched");
  assert.deepEqual(req[3]["#e"], ["prompt-1"]);
  assert.equal(req[2]["#p"][0], relay.pubkey);

  relay.unwatchReplies(["prompt-1"]);
  socket.sent.length = 0;
  relay.poll();
  assert.equal(socket.sent.filter((frame) => frame[0] === "REQ").at(-1).length, 3);
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
  // The server answers a command with `response:{…}`, not with bare JSON. The request succeeds
  // either way, so a parser that chokes on the prefix turns a working feature into a silent one.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ accepted: true, message: `response:${JSON.stringify({ channel_id: "dm-42", created: false })}` }),
  });
  const channel = await relay.openDirectMessage("b".repeat(64));
  assert.equal(channel, "dm-42");

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ accepted: true, message: JSON.stringify({ channel_id: "dm-42" }) }),
  });
  assert.equal(await relay.openDirectMessage("b".repeat(64)), "dm-42", "an unprefixed answer must still work");

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

/**
 * Reported live after Buzz shipped its new app: talking to an agent in a DM did nothing unless
 * the agent was @mentioned. The old app tagged every other DM participant on each message, so
 * the `#p` poll saw them; the new one tags only explicit mentions. A one-to-one DM is now found
 * from the relay's signed rosters and read whole.
 */
test("one-to-one DMs are found from the relay's signed rosters and polled whole", async () => {
  const { relay, socket } = connected();
  authenticate(socket);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const rosterReq = socket.sent.find((f) => f[0] === "REQ" && f[2].kinds?.[0] === 39002);
  assert.ok(rosterReq, "the agent's rosters are asked for once signed in");
  assert.deepEqual(rosterReq[2]["#p"], [key.publicKey]);

  const other = "a".repeat(64);
  const third = "b".repeat(64);
  const roster = (id, members, pubkey = RELAY_SELF) => ({
    id: `r-${id}-${pubkey.slice(0, 2)}`, pubkey, created_at: 1, kind: 39002, sig: "", content: "",
    tags: [["d", id], ...members.map((m) => ["p", m])],
  });
  const metadata = (id, type, pubkey = RELAY_SELF) => ({
    id: `g-${id}`, pubkey, created_at: 1, kind: 39000, sig: "", content: "",
    tags: [["d", id], ["name", "DM"], ["t", type], ["t", "dm"], ["hidden"]],
  });
  socket.deliver(["EVENT", rosterReq[1], roster("dm-1", [key.publicKey, other])]);
  socket.deliver(["EVENT", rosterReq[1], roster("group-dm", [key.publicKey, other, third])]);
  socket.deliver(["EVENT", rosterReq[1], roster("general", [key.publicKey, other])]);
  // A roster anyone could publish is not the relay's word.
  socket.deliver(["EVENT", rosterReq[1], roster("forged", [key.publicKey, other], "f".repeat(64))]);
  socket.deliver(["EOSE", rosterReq[1]]);

  const metaReq = socket.sent.find((f) => f[0] === "REQ" && f[2].kinds?.[0] === 39000);
  assert.ok(metaReq, "then the metadata of those channels");
  assert.deepEqual(new Set(metaReq[2]["#d"]), new Set(["dm-1", "group-dm", "general"]));
  socket.deliver(["EVENT", metaReq[1], metadata("dm-1", "dm")]);
  socket.deliver(["EVENT", metaReq[1], metadata("group-dm", "dm")]);
  // The first `t` is the type; a stream labelled "dm" is still a stream.
  socket.deliver(["EVENT", metaReq[1], metadata("general", "stream")]);
  socket.deliver(["EVENT", metaReq[1], metadata("forged", "dm")]);
  socket.deliver(["EOSE", metaReq[1]]);

  assert.equal(relay.isDirect("dm-1"), true);
  assert.equal(relay.isDirect("group-dm"), false, "a group DM still needs the mention");
  assert.equal(relay.isDirect("general"), false);
  assert.equal(relay.isDirect("forged"), false);

  const catchUp = socket.sent.find((f) => f[0] === "REQ" && f[2]["#h"]);
  assert.ok(catchUp, "a DM found late is read back, so a message sent before it was found is answered");
  assert.deepEqual(catchUp[2]["#h"], ["dm-1"]);
  assert.deepEqual(catchUp[2].kinds, [KIND_MESSAGE]);

  relay.poll();
  const poll = socket.sent.filter((f) => f[0] === "REQ" && f[1].startsWith("m")).at(-1);
  const byChannel = poll.slice(2).find((filter) => filter["#h"]);
  assert.deepEqual(byChannel["#h"], ["dm-1"], "every poll reads the DM, mention or not");
});

test("a discovery event never reaches the bridge as a message, nor moves the poll cursor", async () => {
  const seen = [];
  const { socket } = connected((event) => seen.push(event.id));
  authenticate(socket);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const rosterReq = socket.sent.find((f) => f[0] === "REQ" && f[2].kinds?.[0] === 39002);
  socket.deliver(["EVENT", rosterReq[1], {
    id: "roster", pubkey: RELAY_SELF, created_at: 4_000_000_000, kind: 39002, sig: "", content: "",
    tags: [["d", "dm-1"], ["p", key.publicKey]],
  }]);
  assert.deepEqual(seen, []);
  const before = socket.sent.filter((f) => f[0] === "REQ" && f[1].startsWith("m")).at(-1);
  assert.ok(before[2].since < 4_000_000_000);
});
