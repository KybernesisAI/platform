import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  card,
  cardPrompt,
  cardsFromOutput,
  cardsOf,
  cardText,
  chipFor,
  forModel,
  newStepState,
  parseCard,
  parseCardPrompt,
  parseMarkedPrompt,
  promptText,
  readStep,
  sparkline,
  visibleSteps,
  withCards,
} from "../dist/index.js";

const stats = {
  kyb: 1,
  card: "stats",
  title: "Website · last 7 days",
  source: "Analytics",
  data: { tiles: [{ label: "Visitors", value: "12,480", change: "+8%", tone: "good" }, { label: "Signups", value: "312" }] },
};

test("a well-formed card parses to itself", () => {
  assert.deepEqual(parseCard(stats), stats);
});

test("a card from another envelope version, or with no type, is not a card", () => {
  assert.equal(parseCard({ ...stats, kyb: 2 }), null);
  assert.equal(parseCard({ ...stats, card: "" }), null);
  assert.equal(parseCard("stats"), null);
});

test("bad parts are dropped and good parts kept", () => {
  const parsed = parseCard({ ...stats, data: { tiles: [{ label: "Visitors", value: "12,480" }, { label: "no value" }, "junk"] } });
  assert.equal(parsed.data.tiles.length, 1);
});

test("a known type whose data cannot be drawn shows its text, or is nothing", () => {
  assert.equal(parseCard({ kyb: 1, card: "stats", data: { tiles: [] } }), null);
  const degraded = parseCard({ kyb: 1, card: "stats", data: { tiles: [] }, text: "Visitors 12,480" });
  assert.equal(degraded.card, "unknown");
  assert.equal(degraded.text, "Visitors 12,480");
});

test("a type from a newer version keeps its text for an older client", () => {
  const future = parseCard({ kyb: 1, card: "hologram", data: { x: 1 }, text: "A thing this app cannot draw yet" });
  assert.equal(future.card, "hologram");
  assert.equal(cardText(future), "A thing this app cannot draw yet");
});

test("only web addresses and the agent's own paths survive as links", () => {
  const link = (url) => parseCard({ kyb: 1, card: "link", data: { url } });
  assert.equal(link("javascript:alert(1)"), null);
  assert.equal(link("data:text/html,hi"), null);
  assert.equal(link("//evil.example/x"), null);
  assert.equal(link("file:///etc/passwd"), null);
  assert.equal(link("/eve/v1/kyb/files/abc/report.pdf").data.url, "/eve/v1/kyb/files/abc/report.pdf");
  assert.equal(link("https://example.com/a").data.url, "https://example.com/a");
  const parsed = parseCard({ ...stats, actions: [{ label: "Bad", url: "javascript:x" }, { label: "Ask", say: "Break it down" }] });
  assert.deepEqual(parsed.actions, [{ label: "Ask", say: "Break it down" }]);
});

test("a long table is cut to the limit and remembers how long it was", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ n: i, name: `row ${i}` }));
  const parsed = parseCard({ kyb: 1, card: "table", data: { columns: [{ key: "name", label: "Name" }, { key: "n", label: "N", align: "right" }], rows } });
  assert.equal(parsed.data.rows.length, 50);
  assert.equal(parsed.data.total, 80);
  assert.match(cardText(parsed), /…and 70 more rows/);
});

test("chart labels always line up with the values", () => {
  const parsed = parseCard({ kyb: 1, card: "chart", data: { kind: "line", x: ["Mon"], series: [{ name: "Visitors", values: [1, 2, 3] }] } });
  assert.deepEqual(parsed.data.x, ["Mon", "", ""]);
  assert.equal(parseCard({ kyb: 1, card: "chart", data: { series: [{ name: "x", values: [1, "two"] }] } }), null);
});

test("cards come out of a tool's output, as an object or as JSON text", () => {
  assert.equal(cardsFromOutput({ ok: true, kyb: stats }).length, 1);
  assert.equal(cardsFromOutput(JSON.stringify({ kyb: [stats, stats] })).length, 2);
  assert.deepEqual(cardsFromOutput("Started task field-ops-1."), []);
  assert.deepEqual(cardsFromOutput({ ok: true }), []);
  assert.deepEqual(cardsFromOutput(null), []);
});

test("every known card has a text version", () => {
  const made = [
    card("stats", stats.data, { title: "Website" }),
    card("chart", { kind: "line", x: ["Fri", "Sat", "Sun"], series: [{ name: "Visitors", values: [1620, 1710, 1580] }] }),
    card("checklist", { items: [{ text: "Build", state: "done" }, { text: "Deploy", state: "waiting" }] }),
    card("brief", { name: "Northwind", points: ["Renewal in December"] }),
    card("link", { url: "https://example.com", title: "Example" }),
    card("screenshot", { image: "/eve/v1/kyb/media/a.png", caption: "Order confirmed" }),
    card("file", { url: "https://example.com/r.pdf", name: "r.pdf" }),
    card("artifact", { artifactId: "a1", display: "inline" }, { title: "Signup funnel" }),
    card("pull-request", { repo: "acme/app", number: 412, title: "fix: export", url: "https://github.com/acme/app/pull/412", additions: 18, deletions: 3, checks: [{ name: "Build", state: "passed" }] }),
    card("receipt", { merchant: "Store", amount: 255600, currency: "usd", orderId: "10493827" }),
    card("remembered", { fact: "Ops approves under $5,000." }),
    card("routine", { name: "Weekly pipeline", schedule: "Every Monday at 9:00 AM" }),
  ];
  for (const c of made) assert.ok(c.text && c.text.length > 0, `${c.card} has text`);
  assert.match(made[9].text, /\$2,556\.00/);
  assert.match(made[8].text, /\+18 −3/);
});

test("slack text bolds the title the Slack way", () => {
  const c = parseCard(stats);
  assert.match(cardText(c, "slack"), /^\*Website · last 7 days\* \(Analytics\)/);
});

test("a sparkline spans the range", () => {
  assert.equal(sparkline([1, 2, 3]), "▁▅█");
  assert.equal(sparkline([5, 5]), "▄▄");
  assert.equal(sparkline([]), "");
});

test("marker lines never reach a text channel", () => {
  const vault = '[kyb:vault-item] {"kind":"login","site":"https://portal.example"}\nI need a login for portal.example.';
  assert.equal(promptText(vault), "I need a login for portal.example.");
  assert.equal(promptText("[kyb:card] {broken json\nPlease approve."), "Please approve.");
  assert.equal(promptText("Plain question?"), "Plain question?");
  assert.equal(promptText("[kyb:card] {}"), "[kyb:card] {}", "a prompt that is only a marker is not emptied");
  assert.equal(parseMarkedPrompt(vault).marker, "vault-item");
});

test("a card travels in a question and comes back out", () => {
  const prompt = cardPrompt(parseCard(stats), "Does this look right?");
  const back = parseCardPrompt(prompt);
  assert.deepEqual(back.card, stats);
  assert.equal(back.text, "Does this look right?");
  assert.equal(promptText(prompt), "Does this look right?");
});

test("the model reads the output without the card data", () => {
  const output = withCards({ ok: true, rows: 5 }, parseCard(stats));
  const view = forModel(output);
  assert.equal(view.value.kyb, undefined);
  assert.equal(view.value.rows, 5);
  assert.match(view.value.shownToPerson, /stats "Website · last 7 days"/);
  assert.deepEqual(forModel({ ok: true }), { type: "json", value: { ok: true } });
});

test("chips name what a tool touches", () => {
  assert.equal(chipFor("arcana__arcana_recall"), "Memory");
  assert.equal(chipFor("gmail_send_email"), "Gmail");
  assert.equal(chipFor("posthog_query_insights"), "PostHog");
  assert.equal(chipFor("github__create_pull_request"), "GitHub");
  assert.equal(chipFor("computer"), "Computer");
  assert.equal(chipFor("pay_on_computer"), "Payments");
  assert.equal(chipFor("fill_from_vault"), "Vault");
  assert.equal(chipFor("ask_planner"), "Planner");
  assert.equal(chipFor("field-ops", "remote-agent-call"), "Field ops");
  assert.equal(chipFor("summarise"), "Tool");
});

const events = (lines) => lines.map((l) => (typeof l === "string" ? JSON.parse(l) : l));
const feed = (state, list) => {
  for (const e of list) readStep(state, e.type, e.data, e.meta);
  return state;
};

test("a recorded task call becomes one step that finishes only when the task settles", () => {
  const recorded = events(readFileSync(new URL("./fixtures/agent-to-agent-tasks.jsonl", import.meta.url), "utf8").trim().split("\n"));
  const state = newStepState();
  const upToReceipt = recorded.findIndex((e) => e.type === "action.result") + 1;
  feed(state, recorded.slice(0, upToReceipt));
  let [step] = [...state.steps.values()];
  assert.equal(step.chip, "Field ops");
  assert.match(step.label, /^Field-ops: What is on the sch/, "eve's own label");
  assert.equal(step.status, "running", "the receipt is not the answer");
  feed(state, recorded.slice(upToReceipt));
  [step] = [...state.steps.values()];
  assert.equal(step.status, "done");
});

test("a tool's cards are collected, and a later card with the same id replaces the earlier one", () => {
  const state = newStepState();
  const pending = { ...stats, id: "spend-1", title: "Pending" };
  const approved = { ...stats, id: "spend-1", title: "Approved" };
  feed(state, [
    { type: "actions.requested", data: { turnId: "t1", actions: [{ callId: "a", kind: "tool-call", toolName: "posthog_query_insights", input: {} }], presentation: { a: { label: "Pageviews, last 7 days" } } } },
    { type: "action.result", data: { turnId: "t1", status: "completed", result: { callId: "a", kind: "tool-result", toolName: "posthog_query_insights", output: { kyb: pending } } } },
    { type: "actions.requested", data: { turnId: "t2", actions: [{ callId: "b", kind: "tool-call", toolName: "approve_spend_request", input: {} }] } },
    { type: "action.result", data: { turnId: "t2", status: "completed", result: { callId: "b", kind: "tool-result", toolName: "approve_spend_request", output: JSON.stringify({ kyb: approved }) } } },
  ]);
  const steps = visibleSteps(state.steps.values());
  assert.deepEqual(steps.map((s) => [s.chip, s.label, s.status]), [
    ["PostHog", "Pageviews, last 7 days", "done"],
    ["Payments", "Approve spend request", "done"],
  ]);
  const cards = cardsOf(state.steps.values());
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "Approved");
});

test("the show tool gives a card but no step line, and failures are failures", () => {
  const state = newStepState();
  feed(state, [
    { type: "actions.requested", data: { actions: [{ callId: "s", kind: "tool-call", toolName: "cards__show", input: {} }, { callId: "f", kind: "tool-call", toolName: "gmail_send_email", input: {} }] } },
    { type: "action.result", data: { status: "completed", result: { callId: "s", toolName: "cards__show", output: { kyb: stats } } } },
    { type: "action.result", data: { status: "failed", result: { callId: "f", toolName: "gmail_send_email", output: "quota" } } },
  ]);
  assert.deepEqual(visibleSteps(state.steps.values()).map((s) => [s.chip, s.status]), [["Gmail", "failed"]]);
  assert.equal(cardsOf(state.steps.values()).length, 1);
});

test("plumbing tools and skill loads are not steps", () => {
  const state = newStepState();
  feed(state, [
    { type: "actions.requested", data: { actions: [{ callId: "1", kind: "tool-call", toolName: "eve__search", input: { query: "x" } }, { callId: "2", kind: "load-skill", name: "writing" }] } },
    { type: "action.result", data: { status: "completed", result: { callId: "1", toolName: "eve__search", output: "found 5" } } },
  ]);
  assert.equal(visibleSteps(state.steps.values()).length, 0);
});

test("a tool called through the catalogue is shown as itself", () => {
  const state = newStepState();
  feed(state, [{ type: "actions.requested", data: { actions: [{ callId: "c", kind: "tool-call", toolName: "eve__tool", input: { name: "gmail_send_email", input: {} } }] } }]);
  assert.equal([...state.steps.values()][0].chip, "Gmail");
});

test("an artifact card keeps its display, format and time", () => {
  const parsed = parseCard({
    kyb: 1,
    card: "artifact",
    id: "art_1",
    title: "Signup funnel",
    source: "Artifact",
    data: { artifactId: "art_1", version: 3, display: "inline", format: "html", updatedAt: "2026-10-23T07:00:00Z" },
    actions: [{ label: "Open", artifact: "art_1" }],
  });
  assert.deepEqual(parsed.data, { artifactId: "art_1", version: 3, display: "inline", format: "html", updatedAt: "2026-10-23T07:00:00Z" });
  assert.deepEqual(parsed.actions, [{ label: "Open", artifact: "art_1" }]);
  assert.equal(parseCard({ kyb: 1, card: "artifact", data: { artifactId: "a", format: "exe" } }).data.format, undefined);
});
