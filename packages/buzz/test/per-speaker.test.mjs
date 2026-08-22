import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The bug this guards against had no error attached to it: a second person in a
 * channel asked about their own mail and was shown the first person's, because
 * the cached session handle carried the first person's credentials.
 *
 * So the property under test is not "it works" but "whose token went with the
 * turn" — the only thing that decides whose data an agent may reach.
 */

/** A stand-in for the eve client that records the bearer used per turn. */
function fakeClientFactory(sent) {
  return (token) => ({
    sessions: {
      create: async ({ message }) => {
        sent.push({ token, message, kind: "create" });
        return {
          session: { state: { sessionId: "session-1", streamIndex: 10 } },
          response: { result: async () => ({ message: "ok" }) },
        };
      },
      attach: (sessionId, options) => ({
        state: { sessionId, streamIndex: (options?.streamIndex ?? 0) + 10 },
        send: async (message) => {
          sent.push({ token, message, sessionId, streamIndex: options?.streamIndex, kind: "attach" });
          // A stream read from the beginning replays the conversation, so the
          // first completed message it finds is the PREVIOUS person's answer.
          return {
            result: async () => ({
              message: (options?.streamIndex ?? 0) === 0 ? "somebody else's answer" : "ok",
            }),
          };
        },
      }),
    },
  });
}

/** The bridge's session logic, isolated from the network. */
function makeAsk(clientFor) {
  const sessions = new Map();
  return async function ask(channel, text, token) {
    const client = clientFor(token);
    const existing = sessions.get(channel);
    if (existing) {
      const session = client.sessions.attach(existing.id, { streamIndex: existing.streamIndex });
      const result = await (await session.send(text)).result();
      sessions.set(channel, { id: existing.id, streamIndex: session.state.streamIndex });
      return result.message ?? "";
    }
    const created = await client.sessions.create({ message: text });
    const message = (await created.response.result()).message ?? "";
    sessions.set(channel, {
      id: created.session.state.sessionId,
      streamIndex: created.session.state.streamIndex,
    });
    return message;
  };
}

test("a second speaker's turn carries their own credentials, not the first speaker's", async () => {
  const sent = [];
  const ask = makeAsk(fakeClientFactory(sent));

  await ask("channel-1", "what is my latest email?", "tom-token");
  await ask("channel-1", "what is my latest email?", "ian-token");

  assert.equal(sent.length, 2);
  assert.equal(sent[0].token, "tom-token");
  // The failure mode: this was "tom-token", and nothing reported a problem —
  // Ian was simply shown Tom's inbox.
  assert.equal(sent[1].token, "ian-token");
});

test("both speakers share one conversation, so the thread stays whole", async () => {
  const sent = [];
  const ask = makeAsk(fakeClientFactory(sent));

  await ask("channel-1", "first", "tom-token");
  await ask("channel-1", "second", "ian-token");
  await ask("channel-1", "third", "tom-token");

  assert.equal(sent[0].kind, "create");
  assert.deepEqual(
    sent.slice(1).map((call) => call.sessionId),
    ["session-1", "session-1"],
  );
});

test("a follow-up reads its OWN answer, not the previous speaker's", async () => {
  const sent = [];
  const ask = makeAsk(fakeClientFactory(sent));

  await ask("channel-1", "what is my latest email?", "tom-token");
  const second = await ask("channel-1", "what is my latest email?", "ian-token");

  // Attaching at index 0 replays the conversation and returns whatever was
  // answered first. The turn runs as the right person either way, so this is
  // invisible except as an agent that repeats itself.
  assert.notEqual(second, "somebody else's answer");
  assert.equal(sent[1].streamIndex, 10);
});

test("the stream position advances with each turn", async () => {
  const sent = [];
  const ask = makeAsk(fakeClientFactory(sent));

  await ask("channel-1", "one", "tom-token");
  await ask("channel-1", "two", "ian-token");
  await ask("channel-1", "three", "tom-token");

  assert.equal(sent[1].streamIndex, 10);
  assert.equal(sent[2].streamIndex, 20);
});

test("a different channel is a different conversation", async () => {
  const sent = [];
  const ask = makeAsk(fakeClientFactory(sent));

  await ask("channel-1", "hello", "tom-token");
  await ask("channel-2", "hello", "tom-token");

  assert.equal(sent[0].kind, "create");
  assert.equal(sent[1].kind, "create");
});
