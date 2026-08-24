import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The bug this guards against produced no error, in either direction.
 *
 * `send()` opens its response stream at the position the handle holds and stops
 * at the FIRST turn boundary it meets. When something is still unread there —
 * the tail of a turn that outlived its reader, a turn that was running when the
 * bridge restarted — that boundary belongs to the older turn. This turn's
 * answer is never collected, and the stored position stays a turn behind.
 *
 * Which makes it permanent. Observed in a real channel: five questions in a row
 * answered with nothing, then a question answered with the reply to a question
 * asked ten minutes earlier — while the same agent, asked the same thing in a
 * fresh conversation, answered perfectly. A fresh conversation has nothing left
 * over to trip on, which is exactly what made it look like the room was cursed.
 */

/**
 * A session that models the one behaviour that matters: a read starting before
 * the tail returns whatever the PREVIOUS turn left there.
 */
function fakeClient(sent) {
  // Events the conversation has accumulated. Two turns' worth already unread.
  let tail = 12;
  return {
    sessions: {
      attach(sessionId, options) {
        let index = options?.streamIndex ?? 0;
        return {
          get state() {
            return { sessionId, streamIndex: index };
          },
          async *stream({ startIndex }) {
            // Non-following: yields what is unread and ends at the tail.
            for (let i = startIndex; i < tail; i++) yield { index: i };
            index = tail;
          },
          async send(message) {
            const startedAt = index;
            sent.push({ message, startIndex: startedAt });
            tail += 4; // this turn's own events
            index = tail;
            return {
              result: async () => ({
                // Reading from before the tail hands back the older turn's
                // boundary — no text of our own.
                message: startedAt < 12 ? "" : `answer to ${message}`,
              }),
            };
          },
        };
      },
    },
  };
}

/** The shipped logic: catch up to the tail, then speak. */
async function askWithDrain(client, stored, text) {
  const session = client.sessions.attach("session-1", { streamIndex: stored });
  for await (const _ of session.stream({ follow: false, startIndex: stored })) {
    // drain
  }
  const result = await (await session.send(text)).result();
  return { message: result.message ?? "", index: session.state.streamIndex };
}

/** What it did before: send from wherever the handle happened to be. */
async function askWithoutDrain(client, stored, text) {
  const session = client.sessions.attach("session-1", { streamIndex: stored });
  const result = await (await session.send(text)).result();
  return { message: result.message ?? "", index: session.state.streamIndex };
}

test("a turn started behind the tail comes back empty — the failure as it was", async () => {
  const sent = [];
  const { message } = await askWithoutDrain(fakeClient(sent), 4, "what is our architecture?");

  assert.equal(sent[0].startIndex, 4, "spoke from a stale position");
  assert.equal(message, "", "and got the older turn's boundary instead of an answer");
});

test("catching up to the tail first gets this turn's own answer", async () => {
  const sent = [];
  const { message, index } = await askWithDrain(fakeClient(sent), 4, "what is our architecture?");

  assert.equal(sent[0].startIndex, 12, "spoke from the true end of the conversation");
  assert.equal(message, "answer to what is our architecture?");
  assert.equal(index, 16, "and left the position after its own events");
});

test("a position that has already drifted repairs itself on the next turn", async () => {
  // The property that matters operationally: nobody has to notice, and no
  // channel has to be abandoned and recreated to become usable again.
  const sent = [];
  const client = fakeClient(sent);

  const first = await askWithDrain(client, 0, "first question after the drift");
  assert.equal(first.message, "answer to first question after the drift");

  const second = await askWithDrain(client, first.index, "second question");
  assert.equal(second.message, "answer to second question");
  assert.equal(sent[1].startIndex, first.index, "no gap opened between turns");
});
