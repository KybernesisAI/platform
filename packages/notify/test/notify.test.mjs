import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { askingUser, notify, preview } from "../dist/index.js";

test("the agent names the person from the verified principal, and nobody otherwise", () => {
  assert.equal(askingUser({ session: { auth: { current: { principalId: "user_1" } } } }), "user_1");
  assert.equal(askingUser({ session: { auth: null } }), undefined, "a schedule has no person");
  assert.equal(askingUser(undefined), undefined);
});

test("a preview is one line, cut for a lock screen", () => {
  assert.equal(preview("  two\n\nlines  here "), "two lines here");
  assert.equal(preview("x".repeat(200)).length, 140);
});

test("notify posts the person, the thread and the kind with the agent's credential, and never throws", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}"); });
  });
  await new Promise((r) => server.listen(0, r));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await notify({ issuer, credential: "cred", user: "user_1", sessionId: "wrun_1", kind: "question", body: "Approve?" });
    assert.equal(r.ok, true);
    assert.deepEqual(seen[0], { path: "/api/notify", auth: "Bearer cred", body: { user: "user_1", sessionId: "wrun_1", kind: "question", body: "Approve?" } });
    const down = await notify({ issuer: "http://127.0.0.1:1", credential: "cred", user: "u", sessionId: "s", kind: "reply" });
    assert.equal(down.ok, false, "an unreachable control plane is a lost notification, not a failed turn");
  } finally { server.close(); }
});
