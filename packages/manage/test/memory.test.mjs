import assert from "node:assert/strict";
import { test } from "node:test";
import { callMemory, contentOf, memoryConfig, memoryRoutes } from "../dist/memory.js";

test("config reads the agent's own workspace and key, the eval key for an eval workspace", () => {
  assert.equal(memoryConfig({}, {}), null);
  assert.deepEqual(memoryConfig({}, { ARCANA_COMPANY_WORKSPACE: "acme", ARCANA_API_KEY: "k" }), { workspace: "acme", apiKey: "k", url: "https://mcp.arcana.kybernesis.ai/mcp" });
  assert.equal(memoryConfig({}, { ARCANA_COMPANY_WORKSPACE: "acme-eval", ARCANA_API_KEY: "k", ARCANA_EVAL_API_KEY: "e" }).apiKey, "e");
});

test("a call sends the workspace header and unwraps an SSE answer", async () => {
  let seen;
  const fake = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    const frame = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ content: "# Recent" }) }] } };
    return new Response(`event: message\ndata: ${JSON.stringify(frame)}\n\n`, { status: 200 });
  };
  const text = await callMemory({ workspace: "acme", apiKey: "k", url: "https://m/mcp" }, "arcana_timeline", { limit: 3 }, fake);
  assert.equal(contentOf(text), "# Recent");
  assert.equal(seen.headers["x-kyberagent-agent"], "acme");
  assert.equal(seen.body.params.name, "arcana_timeline");
});

test("a tool error is an error", async () => {
  const fake = async () => Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "nope" }] } });
  await assert.rejects(callMemory({ workspace: "a", apiKey: "k", url: "https://m" }, "x", {}, fake), /nope/);
});

test("routes refuse without the grant and say plainly when there is no memory", async () => {
  const routes = memoryRoutes({ prefix: "/eve/v1/kyb", options: { workspace: undefined, apiKey: undefined }, authorize: async () => null });
  assert.ok(routes.length >= 4);
  const denied = memoryRoutes({ prefix: "/eve/v1/kyb", options: {}, authorize: async () => new Response("no", { status: 403 }) });
  assert.equal(denied.length, routes.length);
});
