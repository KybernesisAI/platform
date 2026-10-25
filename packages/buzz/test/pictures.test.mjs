import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAgentScreenshot, pictureMessage } from "../dist/pictures.js";
import { loadOrCreateKey } from "../dist/keys.js";

const { key } = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "buzz-pictures-")), "agent.json"));

/**
 * Found live: a screenshot card in Buzz said "This picture is on the agent and
 * can't be shown here." The image is served only to the person it was taken
 * for, and neither Buzz nor the plugin holds their token. The bridge now
 * fetches it as that person and posts it as an ordinary Buzz picture.
 */

const ID = "0123456789abcdef0123456789abcdef";

/** A PNG header for a 1280x800 image, which is all the bridge reads. */
function png(width = 1280, height = 800) {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const shot = (data = {}) => ({
  kyb: 1,
  card: "screenshot",
  source: "Computer",
  data: { image: `/eve/v1/kyb/screens/${ID}.png`, caption: "The homepage hero", site: "example.com", ...data },
  text: "The homepage hero (a screenshot is in the KYBER Studio app)",
});

test("only a screenshot named by id on the agent is fetched", () => {
  assert.equal(isAgentScreenshot(shot()), true);
  assert.equal(isAgentScreenshot(shot({ image: `/eve/v1/kyb/screens/${ID}` })), true);
  // Credentials go to the agent's screens route and nowhere else.
  assert.equal(isAgentScreenshot(shot({ image: "https://elsewhere.example/a.png" })), false);
  assert.equal(isAgentScreenshot(shot({ image: "/eve/v1/kyb/screens/../files/x" })), false);
  assert.equal(isAgentScreenshot(shot({ image: "//elsewhere.example/eve/v1/kyb/screens/" + ID })), false);
  assert.equal(isAgentScreenshot({ ...shot(), card: "link" }), false);
});

test("the picture is fetched as the asker and stored in the community it is posted to", async () => {
  const fetched = [];
  const uploads = [];
  const message = await pictureMessage(shot(), {
    agentUrl: "https://agent.example/",
    headers: async () => ({ authorization: "Bearer person-token" }),
    relay: "wss://community.example",
    key,
    fetchImpl: async (url, init) => {
      fetched.push({ url, auth: init.headers.authorization });
      return new Response(png(), { status: 200, headers: { "content-type": "image/png" } });
    },
    upload: async (relay, _key, bytes, mediaType) => {
      uploads.push({ relay, size: bytes.byteLength, mediaType });
      return { url: "https://community.example/media/" + "a".repeat(64) + ".png", sha256: "a".repeat(64), size: bytes.byteLength };
    },
  });
  assert.deepEqual(fetched, [{ url: `https://agent.example/eve/v1/kyb/screens/${ID}.png`, auth: "Bearer person-token" }]);
  assert.deepEqual(uploads, [{ relay: "wss://community.example", size: 64, mediaType: "image/png" }]);

  // Written the way Buzz's own composer writes a picture: words, a Markdown image, its imeta tag.
  const url = "https://community.example/media/" + "a".repeat(64) + ".png";
  assert.equal(message.content, `The homepage hero (example.com)\n\n![The homepage hero](<${url}>)`);
  assert.deepEqual(message.tags, [
    ["imeta", `url ${url}`, "m image/png", `x ${"a".repeat(64)}`, "size 64", "dim 1280x800", "filename screenshot.png"],
  ]);
  // Nothing hidden: the plugin leaves it alone and Buzz draws the picture itself.
  assert.ok(!message.content.includes("kyb:card"));
});

test("a caption cannot break out of the image's Markdown", async () => {
  const message = await pictureMessage(shot({ caption: "A [link](https://x.example) and ![img](y)", site: undefined }), {
    agentUrl: "https://agent.example",
    headers: async () => ({}),
    relay: "wss://community.example",
    key,
    fetchImpl: async () => new Response(png(), { status: 200 }),
    upload: async () => ({ url: "https://community.example/media/b.png", sha256: "b".repeat(64), size: 64 }),
  });
  assert.match(message.content, /^A \[link\]\(https:\/\/x\.example\) and !\[img\]\(y\)\n\n!\[A \\\[link\\\]\\\(https:\/\/x\.example\\\) and \\!\\\[img\\\]\\\(y\\\)\]\(<https:\/\/community\.example\/media\/b\.png>\)$/);
});

test("a screenshot the agent will not hand over is not posted as a picture", async () => {
  const options = {
    agentUrl: "https://agent.example",
    headers: async () => ({}),
    relay: "wss://community.example",
    key,
    upload: async () => {
      throw new Error("must not upload");
    },
  };
  await assert.rejects(
    pictureMessage(shot(), { ...options, fetchImpl: async () => new Response("{}", { status: 404 }) }),
    /404 fetching the screenshot/,
  );
  await assert.rejects(
    pictureMessage(shot(), { ...options, fetchImpl: async () => new Response("<html>", { status: 200 }) }),
    /did not answer with a PNG/,
  );
  // Not a screenshot the bridge carries: no fetch at all.
  assert.equal(await pictureMessage({ ...shot(), card: "link" }, { ...options, fetchImpl: async () => assert.fail("fetched") }), null);
});
