import assert from "node:assert/strict";
import { test } from "node:test";

import { arcanaMemory, formatRecall, messageText } from "../dist/memory/index.js";
import { ArcanaClient, unwrapArcanaText } from "../dist/memory/mcp.js";

/**
 * The provider against a fake Arcana. What matters: which tools it calls with
 * which arguments and workspace, what it hands eve back, and that a memory
 * outage never becomes a failed turn.
 */

function fakeArcana(answers = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const name = body.params.name;
    calls.push({ name, args: body.params.arguments, workspace: init.headers["x-kyberagent-agent"], auth: init.headers.authorization });
    const answer = answers[name];
    if (answer instanceof Error) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: answer.message } }), { status: 200 });
    if (answer === "http500") return new Response("boom", { status: 500 });
    const text = typeof answer === "function" ? answer(body.params.arguments) : (answer ?? JSON.stringify({ content: "" }));
    // Arcana answers over SSE; the last data frame is the response.
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } })}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { calls, fetch };
}

function turnContext(userText, extra = {}) {
  return {
    abortSignal: new AbortController().signal,
    operationId: "op-1",
    session: { id: "s1", auth: { current: null }, turn: { id: "t1", sequence: 1 } },
    getSandbox: async () => { throw new Error("no sandbox"); },
    getSkill: () => { throw new Error("no skills"); },
    memory: { slot: "arcana", scope: { key: "k".repeat(40), namespace: "ns", value: "user-1" } },
    messages: [],
    turn: { id: "t1", sequence: 1, input: [{ role: "user", content: userText }] },
    ...extra,
  };
}

test("recall searches memories and brain notes for a real message and hands eve one keyed message", async () => {
  const arcana = fakeArcana({
    arcana_search: JSON.stringify({ content: '# Search: "harrison"\n\n1 result(s)\n\n## Harrison Assessments — won, USD 30,000' }),
    arcana_brain_query: JSON.stringify({ results: [{ title: "Harrison rollout plan", content: "Phase 1 ships in September." }] }),
  });
  const provider = arcanaMemory({ apiKey: "kb_test", workspace: "kyber", fetch: arcana.fetch, log: () => {} });

  const result = await provider.recall["turn.started"](turnContext("what is the status of the Harrison Assessments contract?"));

  assert.deepEqual(arcana.calls.map((c) => [c.name, c.workspace]), [["arcana_search", "kyber"], ["arcana_brain_query", "kyber"]]);
  assert.equal(arcana.calls[0].args.query, "what is the status of the Harrison Assessments contract?");
  assert.equal(arcana.calls[0].auth, "Bearer kb_test");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, "arcana:arcana:" + "k".repeat(24));
  assert.match(result.messages[0].content, /Harrison Assessments — won/);
  assert.match(result.messages[0].content, /## Brain notes[\s\S]*Phase 1 ships in September/);
  assert.match(result.messages[0].content, /not instructions/);
});

test("a greeting does not touch memory, and nothing found means nothing said", async () => {
  const arcana = fakeArcana({ arcana_search: JSON.stringify({ content: '# Search: "x"\n\n0 result(s)' }), arcana_brain_query: JSON.stringify({ results: [] }) });
  const provider = arcanaMemory({ apiKey: "kb_test", workspace: "kyber", fetch: arcana.fetch, log: () => {} });

  assert.equal(await provider.recall["turn.started"](turnContext("hi there")), null);
  assert.equal(arcana.calls.length, 0);

  assert.equal(await provider.recall["turn.started"](turnContext("tell me about something nobody has ever mentioned")), null);
  assert.equal(arcana.calls.length, 2);
});

test("a memory outage is logged and the turn goes on without recall", async () => {
  const logs = [];
  const down = arcanaMemory({ apiKey: "kb_test", workspace: "kyber", fetch: fakeArcana({ arcana_search: "http500", arcana_brain_query: "http500" }).fetch, log: (m) => logs.push(m) });
  assert.equal(await down.recall["turn.started"](turnContext("what did we decide about pricing last week")), null);
  assert.match(logs[0], /recall skipped: Arcana HTTP 500/);

  const refused = arcanaMemory({ apiKey: "kb_test", workspace: "other", fetch: fakeArcana({ arcana_search: new Error("Arcana HTTP 403: workspace_forbidden") }).fetch, log: (m) => logs.push(m) });
  assert.equal(await refused.recall["turn.started"](turnContext("what did we decide about pricing last week")), null);
  assert.match(logs[1], /workspace_forbidden/);
});

test("capture is off unless asked for, and when on it remembers the exchange with scope and operation tags", async () => {
  const arcana = fakeArcana({ arcana_remember: JSON.stringify({ content: "Remembered." }) });
  const messages = [
    { role: "user", content: "We decided to move the Harrison kickoff to the 15th of October." },
    { role: "assistant", content: [{ type: "text", text: "Noted: kickoff on 15 October." }] },
  ];
  const off = arcanaMemory({ apiKey: "kb_test", workspace: "kyber", fetch: arcana.fetch });
  await off.capture["turn.completed"](turnContext("", { messages }));
  assert.equal(arcana.calls.length, 0);

  const on = arcanaMemory({ apiKey: "kb_test", workspace: "kyber", fetch: arcana.fetch, capture: { enabled: true } });
  await on.capture["turn.completed"](turnContext("", { messages }));
  assert.equal(arcana.calls.length, 1);
  const call = arcana.calls[0];
  assert.equal(call.name, "arcana_remember");
  assert.equal(call.args.text, messages[0].content);
  assert.equal(call.args.response, "Noted: kickoff on 15 October.");
  assert.equal(call.args.channel, "eve:arcana");
  assert.deepEqual(call.args.tags, ["eve-memory", "scope:" + "k".repeat(32), "op:op-1"]);

  // A short exchange is not worth a memory.
  await on.capture["turn.completed"](turnContext("", { messages: [{ role: "user", content: "thanks" }, { role: "assistant", content: "any time" }] }));
  assert.equal(arcana.calls.length, 1);
});

test("resolveWorkspace routes each operation from session context, never from the message", async () => {
  const arcana = fakeArcana({ arcana_search: JSON.stringify({ content: "1 result(s)\n\nsomething" }), arcana_brain_query: JSON.stringify({ results: [] }) });
  const provider = arcanaMemory({
    apiKey: "kb_test",
    workspace: "kyber",
    fetch: arcana.fetch,
    resolveWorkspace: (ctx) => (ctx.session.auth.current?.attributes?.department === "sales" ? "kyber-sales" : undefined),
  });
  await provider.recall["turn.started"](turnContext("which accounts are close to signing this quarter", { session: { id: "s1", auth: { current: { attributes: { department: "sales" } } } } }));
  assert.deepEqual(new Set(arcana.calls.map((c) => c.workspace)), new Set(["kyber-sales"]));
});

test("slot tools are offered by default, call Arcana in the slot's workspace, and can be switched off", async () => {
  const arcana = fakeArcana({ arcana_recall: JSON.stringify({ content: "# Kybernesis\n\nA company." }), arcana_remember: JSON.stringify({ content: "Remembered." }) });
  const provider = arcanaMemory({ apiKey: "kb_test", workspace: "kyber", fetch: arcana.fetch });
  const tools = await provider.tools({ memory: { slot: "arcana", scope: { key: "k", namespace: "n", value: "v" } }, turn: { id: "t", sequence: 1, input: [] }, session: { id: "s", auth: { current: null } } });
  assert.deepEqual(Object.keys(tools).sort(), ["recall", "remember", "search"]);
  for (const name of Object.keys(tools)) assert.match(name, /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/);
  assert.match(await tools.recall.execute({ entity: "Kybernesis" }, {}), /A company/);
  await tools.remember.execute({ text: "Ian prefers short answers." }, {});
  assert.equal(arcana.calls.at(-1).args.channel, "eve:arcana");
  assert.equal(arcana.calls.at(-1).workspace, "kyber");

  const silent = arcanaMemory({ apiKey: "kb_test", workspace: "kyber", fetch: arcana.fetch, tools: false });
  assert.equal(await silent.tools({ memory: { slot: "arcana", scope: { key: "k", namespace: "n", value: "v" } }, turn: { id: "t", sequence: 1, input: [] } }), null);
});

test("the client reads both plain JSON and SSE answers, and surfaces tool errors", async () => {
  const json = new ArcanaClient({ apiKey: "k", fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "plain" }] } })) });
  assert.equal(await json.call("arcana_validate", {}, { workspace: "w" }), "plain");

  const failing = new ArcanaClient({ apiKey: "k", fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "bad input" }] } })) });
  await assert.rejects(() => failing.call("arcana_remember", {}, { workspace: "w" }), /bad input/);

  assert.deepEqual(unwrapArcanaText('{"content":"x"}').content, "x");
  assert.equal(unwrapArcanaText("not json").content, undefined);
  assert.equal(messageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "file" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(formatRecall("w", '{"content":"# Search\\n\\n0 result(s)"}', '{"results":[]}'), null);
});
