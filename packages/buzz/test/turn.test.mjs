import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ClientError } from "eve/client";
import { composeMessage, rejectedTurnReply } from "../dist/turn.js";

const imageRef = { url: "https://relay.example/image" };
const image = {
  url: imageRef.url,
  mediaType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
};

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
