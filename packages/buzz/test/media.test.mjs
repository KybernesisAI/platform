import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";

import { parseMedia, fetchMedia, isImage } from "../dist/media.js";
import { loadOrCreateKey } from "../dist/keys.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { key } = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "buzz-media-")), "agent.json"));

/**
 * Reported from a live deployment: an image with a caption was answered as
 * though the caption were the whole message, and an image with no caption
 * produced no reply and no log line at all. Neither failed loudly, and the
 * agent could not tell either had happened — it speculated about its own vision
 * support, which was fine all along.
 */

test("an attachment is read from the imeta tag, not from the message text", () => {
  const event = {
    id: "e", pubkey: "p", created_at: 0, kind: 9, sig: "s",
    content: "resending the screenshot to test if you get it this time",
    tags: [
      ["h", "channel-1"],
      ["imeta", "url https://relay.example/abc", "m image/png", "x deadbeef"],
    ],
  };
  // The content is prose ABOUT the picture — a bridge reading only content
  // sees a caption and no image, which is exactly what happened.
  assert.deepEqual(parseMedia(event), [
    { url: "https://relay.example/abc", mediaType: "image/png", sha256: "deadbeef" },
  ]);
});

test("several attachments on one message all come through", () => {
  const event = {
    id: "e", pubkey: "p", created_at: 0, kind: 9, sig: "s", content: "",
    tags: [
      ["imeta", "url https://relay.example/one", "m image/png"],
      ["imeta", "url https://relay.example/two", "m image/jpeg"],
    ],
  };
  assert.equal(parseMedia(event).length, 2);
});

test("a message with no attachments parses as none, not as an error", () => {
  assert.deepEqual(parseMedia({ id: "e", pubkey: "p", created_at: 0, kind: 9, sig: "s", content: "hello", tags: [["h", "c"]] }), []);
});

test("media is fetched with signed authorization, because an anonymous GET is refused", async () => {
  let seen = null;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init?.headers?.authorization };
    return {
      ok: true,
      headers: { get: (name) => (name === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => bytes.buffer,
    };
  };
  const media = await fetchMedia(key, { url: "https://relay.example/abc" }, fetchImpl);
  assert.equal(media.mediaType, "image/png");
  assert.ok(seen.auth?.startsWith("Nostr "), "the request must carry the agent's own signature");
});

test("the server's content type wins over the sender's claim", async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => new Uint8Array([9]).buffer,
  });
  // A wrong media type reaches the model as an image it cannot decode.
  const media = await fetchMedia(key, { url: "u", mediaType: "image/png" }, fetchImpl);
  assert.equal(media.mediaType, "image/jpeg");
});

test("bytes that do not match the hash they were addressed by are refused", async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  await assert.rejects(
    () => fetchMedia(key, { url: "u", sha256: "not-the-hash" }, fetchImpl),
    /content hash mismatch/,
  );
});

test("a hash that does match is accepted", async () => {
  const bytes = new Uint8Array([7, 7, 7]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => bytes.buffer,
  });
  const media = await fetchMedia(key, { url: "u", sha256 }, fetchImpl);
  assert.equal(media.bytes.length, 3);
});

test("a refused fetch reports its status rather than returning empty bytes", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(() => fetchMedia(key, { url: "https://relay.example/x" }, fetchImpl), /401/);
});

test("only images are shown to the model; other files are described", () => {
  assert.equal(isImage("image/png"), true);
  assert.equal(isImage("application/zip"), false);
});
