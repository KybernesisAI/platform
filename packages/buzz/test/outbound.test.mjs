import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { channelsFrom, configuredRelays, postMessage } from "../dist/outbound.js";
import { loadOrCreateKey } from "../dist/keys.js";

const meta = (id, tags) => ({ id: `e-${id}`, pubkey: "r", created_at: 1, kind: 39000, tags: [["d", id], ...tags], content: "", sig: "" });

test("rooms are found by name; direct messages are never rooms", () => {
  const found = channelsFrom(
    [
      meta("c-dev", [["name", "dev"], ["t", "stream"]]),
      meta("c-dm", [["name", "dm"], ["t", "dm"]]),
      meta("c-sales", [["name", "#sales"]]),
      meta("c-noname", [["t", "stream"]]),
      { ...meta("c-other", [["name", "other"]]), kind: 9 },
    ],
    "wss://team.example",
  );
  assert.deepEqual(found, [
    { id: "c-dev", name: "dev", relay: "wss://team.example" },
    { id: "c-sales", name: "sales", relay: "wss://team.example" },
  ]);
});

test("relays come from BUZZ_RELAY, as the bridge reads them", () => {
  assert.deepEqual(configuredRelays({ BUZZ_RELAY: "wss://a.example, wss://b.example" }), ["wss://a.example", "wss://b.example"]);
  assert.deepEqual(configuredRelays({}), []);
});

test("a post goes through the CLI with the words on stdin and the chosen community", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-post-"));
  const keyFile = join(dir, "key.json");
  loadOrCreateKey(keyFile);
  // A stand-in CLI that records what it was given.
  const cli = join(dir, "buzz");
  writeFileSync(
    cli,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${dir}/args\nprintf '%s' "$BUZZ_RELAY_URL" > ${dir}/relay\ncat > ${dir}/stdin\necho '{"ok":true}'\n`,
  );
  chmodSync(cli, 0o755);
  const env = { PATH: process.env.PATH, BUZZ_CLI_PATH: cli, BUZZ_KEYFILE: keyFile, BUZZ_RELAY: "wss://one.example,wss://two.example" };

  await assert.rejects(postMessage({ channel: "c-dev", text: "hi" }, env), /more than one workspace/);

  const out = await postMessage({ channel: "c-dev", text: "line one\n\nline two; rm -rf ~", relay: "two" }, env);
  assert.equal(out, '{"ok":true}');
  assert.deepEqual(readFileSync(join(dir, "args"), "utf8").trim().split("\n"), ["messages", "send", "--channel", "c-dev", "--content", "-"]);
  assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "line one\n\nline two; rm -rf ~");
  assert.equal(readFileSync(join(dir, "relay"), "utf8"), "https://two.example");
});

test("a failed post says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-post-"));
  const keyFile = join(dir, "key.json");
  loadOrCreateKey(keyFile);
  const cli = join(dir, "buzz");
  writeFileSync(cli, `#!/bin/sh\ncat > /dev/null\necho '{"error":"relay_membership_required"}' >&2\nexit 3\n`);
  chmodSync(cli, 0o755);
  const env = { PATH: process.env.PATH, BUZZ_CLI_PATH: cli, BUZZ_KEYFILE: keyFile, BUZZ_RELAY: "wss://one.example" };
  await assert.rejects(postMessage({ channel: "c-dev", text: "hi" }, env), /relay_membership_required/);
});
