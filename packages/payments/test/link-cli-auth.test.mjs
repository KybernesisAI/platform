import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { linkCliAuth, linkCliAuthFile, readStoredAuth, NOT_SIGNED_IN } from "../dist/index.js";

test("the auth file follows LINK_AUTH_FILE, then the CLI's conf location", () => {
  assert.equal(linkCliAuthFile("/x/y.json"), "/x/y.json");
  process.env.LINK_AUTH_FILE = "/from/env.json";
  assert.equal(linkCliAuthFile(), "/from/env.json");
  delete process.env.LINK_AUTH_FILE;
  assert.match(linkCliAuthFile(), /link-cli-nodejs\/config\.json$/);
});

test("a live token is handed over without touching the CLI; a missing sign-in says what the owner must do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "link-auth-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ auth: { access_token: "tok_live", refresh_token: "r", expires_at: Date.now() + 3_600_000 } }));
  const provider = linkCliAuth({ authFile: file, cliPath: "/nonexistent/link-cli" });
  const result = await provider.getToken({ principal: { type: "app", id: "app" }, connection: { url: "" } });
  assert.equal(result.token, "tok_live");
  assert.equal(readStoredAuth(join(dir, "missing.json")), null);
  const none = linkCliAuth({ authFile: join(dir, "missing.json"), cliPath: "/nonexistent/link-cli" });
  await assert.rejects(() => none.getToken({ principal: { type: "app", id: "app" }, connection: { url: "" } }), new RegExp(NOT_SIGNED_IN.slice(0, 30)));
});

test("near expiry it asks the CLI to refresh and re-reads; a failed refresh still returns what is on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "link-auth-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ auth: { access_token: "tok_old", expires_at: Date.now() + 1000 } }));
  const provider = linkCliAuth({ authFile: file, cliPath: "/nonexistent/link-cli", refreshSkewMs: 60_000 });
  const result = await provider.getToken({ principal: { type: "app", id: "app" }, connection: { url: "" } });
  assert.equal(result.token, "tok_old");
});

test("card material never reaches the model: sanitizeLinkOutput strips it at any depth", async () => {
  const { sanitizeLinkOutput, LINK_TOOL_NAMES, linkTool } = await import("../dist/index.js");
  const out = sanitizeLinkOutput({ id: "sr_1", status: "approved", card: { number: "4242" }, nested: [{ credential: "x", amount: 5, number: "1" }] });
  assert.deepEqual(out, { id: "sr_1", status: "approved", nested: [{ amount: 5 }] });
  assert.ok(LINK_TOOL_NAMES.includes("create_spend_request"));
  const tool = linkTool("retrieve_spend_request", { authFile: "/nonexistent.json", cliPath: "/nonexistent/link-cli" });
  assert.ok(tool, "a tool definition is produced without touching the network");
});

test("the approval prompt carries a card a client can draw, and a sentence with the link for everyone else", async () => {
  const { spendRequestPrompt, parseSpendRequestPrompt, approveSpendRequestTool } = await import("../dist/index.js");
  const prompt = spendRequestPrompt({ id: "lsrq_1", amount: 100, currency: "usd", merchant: "Wikimedia Foundation", approval_url: "https://app.link.com/a/x", status: "pending_approval" });
  const parsed = parseSpendRequestPrompt(prompt);
  assert.equal(parsed.ask.id, "lsrq_1");
  assert.match(parsed.text, /A purchase of 1\.00 USD at Wikimedia Foundation is waiting/);
  assert.match(parsed.text, /https:\/\/app\.link\.com\/a\/x/);
  assert.ok(approveSpendRequestTool({ authFile: "/nonexistent.json" }));
});
