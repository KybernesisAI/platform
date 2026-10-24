import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  approvalCard,
  card,
  cardPrompt,
  cardsFromOutput,
  cardsOf,
  cardText,
  chipFor,
  labelFor,
  withUnit,
  forModel,
  formAnswer,
  formPrompt,
  newStepState,
  parseCard,
  parseCardPrompt,
  parseMarkedPrompt,
  promptText,
  readFormAnswer,
  describeCron,
  nextCronRun,
  routineSchedule,
  shiftCron,
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
    card("approval", { kind: "email", tool: "gmail_send_email", action: "Send email", to: ["dana@northwind.example"], subject: "Renewal", body: "Hi Dana" }),
    card("form", { fields: [{ id: "budget", label: "Budget", kind: "number" }] }),
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
  assert.equal(chipFor("googlecalendar_events_list"), "Google Calendar");
  assert.equal(chipFor("create_routine"), "Routines");
  assert.equal(chipFor("create_report"), "Payments");
  assert.equal(chipFor("ask_form"), "Form");
  assert.equal(chipFor("googlecalendar__events_list"), "Google Calendar");
  assert.equal(labelFor("googlecalendar_events_list", "Google Calendar"), "Events list");
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

test("units read as words in fallbacks", () => {
  assert.equal(withUnit("30", "emails"), "30 emails");
  assert.equal(withUnit("2.5", "%"), "2.5%");
  assert.equal(withUnit("7", undefined), "7");
  const text = cardText({ kyb: 1, card: "chart", data: { kind: "bar", x: ["Mon", "Tue"], series: [{ name: "Inbox", values: [3, 30] }], unit: "emails" } });
  assert.match(text, /latest 30 emails/);
});

test("a memory save becomes a remembered card, with ways to correct it", () => {
  const state = newStepState();
  feed(state, [
    { type: "actions.requested", data: { actions: [{ callId: "m", kind: "tool-call", toolName: "arcana__memory__arcana_remember", input: { text: "Favourite coffee is a flat white." } }] } },
    { type: "action.result", data: { status: "completed", result: { callId: "m", toolName: "arcana__memory__arcana_remember", output: { content: [{ type: "text", text: "{\"ok\":true}" }] } } } },
  ]);
  const [made] = cardsOf(state.steps.values());
  assert.equal(made.card, "remembered");
  assert.equal(made.data.fact, "Favourite coffee is a flat white.");
  assert.deepEqual(made.actions.map((a) => a.label), ["Correct it", "Forget it"]);
  assert.match(made.text, /^Noted: Favourite coffee/);
});

test("a failed memory save, or one with no text, remembers nothing", () => {
  const state = newStepState();
  feed(state, [
    { type: "actions.requested", data: { actions: [{ callId: "m", kind: "tool-call", toolName: "arcana_remember", input: { text: "x" } }, { callId: "n", kind: "tool-call", toolName: "arcana_remember", input: {} }] } },
    { type: "action.result", data: { status: "failed", result: { callId: "m", toolName: "arcana_remember", output: "403" } } },
    { type: "action.result", data: { status: "completed", result: { callId: "n", toolName: "arcana_remember", output: "ok" } } },
  ]);
  assert.equal(cardsOf(state.steps.values()).length, 0);
});

test("a pull request opened through a connector becomes a pull request card", () => {
  const state = newStepState();
  const pr = { number: 412, title: "fix: include final page", html_url: "https://github.com/acme/app/pull/412", body: "The paginator stopped one short.\n\nTest added.", additions: 18, deletions: 3 };
  feed(state, [
    { type: "actions.requested", data: { actions: [{ callId: "p", kind: "tool-call", toolName: "github__create_pull_request", input: { title: "fix: include final page" } }] } },
    { type: "action.result", data: { status: "completed", result: { callId: "p", toolName: "github__create_pull_request", output: JSON.stringify(pr) } } },
  ]);
  const [made] = cardsOf(state.steps.values());
  assert.equal(made.card, "pull-request");
  assert.deepEqual([made.data.repo, made.data.number, made.data.additions, made.data.summary], ["acme/app", 412, 18, "The paginator stopped one short."]);
  assert.equal(made.actions[0].url, "https://github.com/acme/app/pull/412/files");
});

test("an approval shows the email it would send, and never a secret", () => {
  const email = approvalCard("gmail_send_email", { to: ["dana@northwind.example"], subject: "Renewal terms", body: "Hi Dana,\nFinance approved 8%." }, "ask-1");
  assert.deepEqual([email.card, email.id, email.data.kind, email.data.action, email.data.service, email.data.to[0], email.data.subject], ["approval", "ask-1", "email", "Send email", "Gmail", "dana@northwind.example", "Renewal terms"]);
  const event = approvalCard("googlecalendar_create_event", { summary: "Renewal call", start: { dateTime: "2026-10-29T15:00:00Z" }, attendees: [{ email: "dana@northwind.example" }], location: "Zoom" });
  assert.deepEqual([event.data.kind, event.data.subject, event.data.when, event.data.people[0], event.data.service], ["event", "Renewal call", "2026-10-29T15:00:00Z", "dana@northwind.example", "Google Calendar"]);
  const other = approvalCard("delete_asset", { name: "logo.png", api_key: "sk_live_x", password: "p" });
  assert.equal(other.data.kind, "action");
  assert.deepEqual(other.data.fields, [{ label: "Name", value: "logo.png" }]);
  assert.match(email.text, /To: dana@northwind\.example/);
});

test("a form travels in a question and its answer comes back as values", () => {
  const prompt = formPrompt([{ id: "budget", label: "Budget", kind: "number", required: true }, { id: "size", label: "Team size", kind: "choice", options: ["1-10", "11-50"] }, { id: "bad id", label: "x", kind: "text" }], "A few details for the quote.", { submit: "Get quote" });
  const asked = parseCardPrompt(prompt);
  assert.equal(asked.card.card, "form");
  assert.deepEqual(asked.card.data.fields.map((f) => f.id), ["budget", "size"]);
  assert.equal(asked.card.data.submit, "Get quote");
  assert.equal(promptText(prompt), "A few details for the quote.");
  assert.deepEqual(readFormAnswer(formAnswer({ budget: "5000", size: "1-10" })), { values: { budget: "5000", size: "1-10" } });
  assert.deepEqual(readFormAnswer("about five grand"), { text: "about five grand" });
  assert.throws(() => formPrompt([{ id: "", label: "" }], "?"));
});

test("cron reads as words, and the unusual stays as written", () => {
  assert.equal(describeCron("40 8 * * 1-5"), "Weekdays at 8:40 AM");
  assert.equal(describeCron("0 10 * * *"), "Every day at 10:00 AM");
  assert.equal(describeCron("0 9 * * 1"), "Every Monday at 9:00 AM");
  assert.equal(describeCron("30 17 * * 1,3,5"), "Monday, Wednesday and Friday at 5:30 PM");
  assert.equal(describeCron("0 12 15 * *"), "Monthly on day 15 at 12:00 PM");
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("0 * * * *"), "Every hour, on the hour");
  assert.equal(describeCron("0 9 1 1 *"), "0 9 1 1 *");
});

test("the next run is the first matching minute after now, in host time", () => {
  const from = new Date(2026, 9, 24, 9, 30); // Saturday 24 Oct 2026, 09:30 local
  const at = (iso) => new Date(iso);
  const weekday = at(nextCronRun("40 8 * * 1-5", from));
  assert.deepEqual([weekday.getDay(), weekday.getHours(), weekday.getMinutes()], [1, 8, 40]);
  const today = at(nextCronRun("0 10 * * *", from));
  assert.deepEqual([today.getDate(), today.getHours()], [24, 10]);
  const quarter = at(nextCronRun("*/15 * * * *", from));
  assert.deepEqual([quarter.getHours(), quarter.getMinutes()], [9, 45]);
  assert.equal(nextCronRun("not a cron", from), undefined);
  assert.equal(nextCronRun("0 9 31 2 *", from), undefined);
});

test("a pull request opened through a broker connector, wrapped in data, becomes a card", () => {
  const state = newStepState();
  const wrapped = { successful: true, error: null, data: { number: 5, title: "Add a README line", html_url: "https://github.com/acme/app/pull/5", body: "Safe to close." } };
  feed(state, [
    { type: "actions.requested", data: { actions: [{ callId: "c", kind: "tool-call", toolName: "github_create_a_pull_request", input: { title: "Add a README line" } }] } },
    { type: "action.result", data: { status: "completed", result: { callId: "c", toolName: "github_create_a_pull_request", output: wrapped } } },
  ]);
  const [made] = cardsOf(state.steps.values());
  assert.equal(made.card, "pull-request");
  assert.deepEqual([made.data.repo, made.data.number, made.data.title], ["acme/app", 5, "Add a README line"]);
});

test("an event booked by length gets its end time, in the start's own form", () => {
  const event = approvalCard("googlecalendar_create_event", { summary: "Card test", start_datetime: "2026-10-25T15:00:00", event_duration_minutes: 15, timezone: "Asia/Bangkok" });
  assert.deepEqual([event.data.when, event.data.until], ["2026-10-25T15:00:00", "2026-10-25T15:15:00"]);
  const late = approvalCard("googlecalendar_create_event", { summary: "Late", start_datetime: "2026-10-25T23:30", event_duration_hour: 1 });
  assert.equal(late.data.until, "2026-10-26T00:30");
});

test("a cron moves to another time zone, days and all", () => {
  assert.equal(shiftCron("40 1 * * 1-5", 420), "40 8 * * 1-5");
  assert.equal(shiftCron("0 20 * * 1-5", 420), "0 3 * * 2,3,4,5,6");
  assert.equal(shiftCron("30 2 * * 1", -180), "30 23 * * 0");
  assert.equal(shiftCron("0 9 * * *", 330), "30 14 * * *");
  assert.equal(shiftCron("15 * * * *", 330), "45 * * * *");
  assert.equal(shiftCron("*/10 * * * *", 420), "*/10 * * * *");
  assert.equal(shiftCron("0 23 1 * *", 120), undefined);
  assert.equal(shiftCron("0 9 * 1 *", 60), undefined);
});

test("a routine card says its time in the reader's own zone", () => {
  const local = -new Date("2026-10-26T01:40:00Z").getTimezoneOffset();
  const data = { name: "Day summary", schedule: "Weekdays at 1:40 AM", cron: "40 1 * * 1-5", offset: 0, nextRun: "2026-10-26T01:40:00Z" };
  const expected = describeCron(shiftCron("40 1 * * 1-5", local));
  assert.equal(routineSchedule(data), expected);
  assert.equal(routineSchedule({ name: "x", schedule: "Weekdays at 1:40 AM" }), "Weekdays at 1:40 AM");
  const parsed = parseCard(card("routine", data));
  assert.deepEqual([parsed.data.cron, parsed.data.offset], ["40 1 * * 1-5", 0]);
});
