import assert from "node:assert/strict";
import { test } from "node:test";

import { activityFrom, commentaryChunks, isSilent, muLawDecode, parseControl } from "../dist/stream.js";

/** Reference encoder (G.711), to build test frames from known samples. */
function muLawEncode(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let s = sample;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7, mask = 0x4000;
  while (exponent > 0 && (s & mask) === 0) { exponent--; mask >>= 1; }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

test("mu-law decodes to within G.711's step size", () => {
  for (const x of [0, 100, 1000, -1000, 20000, -20000]) {
    const y = muLawDecode(muLawEncode(x));
    assert.ok(Math.abs(y - x) <= Math.max(8, Math.abs(x) * 0.06), `${x} -> ${y}`);
  }
});

/**
 * GPT-Live streams continuously; over a five-minute call 95% of it was exact
 * digital silence. That must never be sent down the iPhone relay.
 */
test("digital silence is gated", () => {
  assert.equal(isSilent(new Uint8Array(800).fill(0xff)), true, "positive zero");
  assert.equal(isSilent(new Uint8Array(800).fill(0x7f)), true, "negative zero");
});

test("speech is never gated, even when quiet", () => {
  const frame = new Uint8Array(800).fill(0xff);
  frame[400] = muLawEncode(300); // one quiet sample in a silent frame
  assert.equal(isSilent(frame), false);
  const tone = Uint8Array.from({ length: 800 }, (_, i) => muLawEncode(Math.round(2000 * Math.sin(i / 3))));
  assert.equal(isSilent(tone), false);
});

test("control frames are JSON with a type; audio is everything else", () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.deepEqual(parseControl(enc('{"type":"hangup"}')), { type: "hangup" });
  assert.equal(parseControl(enc('{"no":"type"}')), null);
  assert.equal(parseControl(new Uint8Array(800).fill(0xff)), null);
  const audioStartingWithBrace = new Uint8Array(800).fill(0x7b);
  assert.equal(parseControl(audioStartingWithBrace), null, "audio that begins with { is still audio");
});

/** GPT-Live takes at most 500 tokens per commentary append. */
test("long replies split on sentences, short ones pass whole", () => {
  assert.deepEqual(commentaryChunks("  Short   answer. "), ["Short answer."]);
  assert.deepEqual(commentaryChunks(""), []);
  const long = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i} of a long spoken answer.`).join(" ");
  const chunks = commentaryChunks(long);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1400, `chunk of ${c.length}`);
  for (const c of chunks.slice(0, -1)) assert.match(c, /\.$/, "breaks at a sentence");
  assert.equal(chunks.join(" "), long.replace(/\s+/g, " ").trim());
});

test("activity names the tool when there is one", () => {
  assert.equal(activityFrom({ type: "actions.requested", data: { actions: [{ toolName: "gmail__search_messages" }] } }), "Using gmail › search messages");
  assert.equal(activityFrom({ type: "actions.requested", data: {} }), "Working");
  assert.equal(activityFrom({ type: "reasoning.appended" }), "Thinking");
  assert.equal(activityFrom({ type: "message.appended" }), null);
});
