import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureRunEvent, manageChannel, newRunCapture, readRoutine, readThread, routineTools, settleRun } from "../dist/index.js";

// The background rebuild is not under test; a shell that does nothing stands in.
process.env.SHELL = "/bin/true";

const dana = { authenticator: "kybernesis", issuer: "https://cp.example", principalId: "user_dana", principalType: "user", attributes: { org: "org_1" } };
const asDana = { session: { auth: { current: dana } } };

const ROOMS = {
  channels: [
    { id: "c-dev", name: "dev", relay: "wss://team.example" },
    { id: "c-sales", name: "sales", relay: "wss://team.example" },
    { id: "c-general-1", name: "general", relay: "wss://team.example" },
    { id: "c-general-2", name: "general", relay: "wss://team.example" },
  ],
  unreadable: [],
};

function agent(files = {}) {
  const appRoot = mkdtempSync(join(tmpdir(), "routine-delivery-"));
  writeFileSync(join(appRoot, "package.json"), "{}");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(appRoot, path, ".."), { recursive: true });
    writeFileSync(join(appRoot, path), body);
  }
  const calls = [];
  const buzzRunner = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === "channels") return JSON.stringify(ROOMS);
    return '{"ok":true}';
  };
  return { appRoot, calls, buzzRunner, tools: routineTools({ appRoot, buzzRunner }) };
}

const schedule = (appRoot, name) => readFileSync(join(appRoot, "agent/schedules", `${name}.ts`), "utf8");

test("a routine made as normal reports in Studio and on the phone", async () => {
  const { appRoot, tools } = agent();
  const out = await tools.create_routine.execute({ name: "Morning brief", cron: "0 1 * * *", instruction: "Send the brief." }, asDana);
  assert.equal(out.deliversTo, "KYBER Studio");
  assert.deepEqual(out.kyb.data.posts, ["KYBER Studio"]);
  const source = schedule(appRoot, "morning-brief");
  assert.match(source, /to\(manage, \{ routine: "morning-brief" \}\)/);
  assert.doesNotMatch(source, /delivery/);
  assert.equal(readRoutine(source).delivery, undefined);
});

test("a routine that names a Buzz room posts there, found by name once", async () => {
  const { appRoot, tools, calls } = agent();
  const out = await tools.create_routine.execute(
    { name: "Open PRs", cron: "0 1 * * *", instruction: "List the open pull requests on GitHub.", deliver_to: { surface: "buzz", channel: "#Dev" } },
    asDana,
  );
  assert.deepEqual(calls.map((c) => c.args), [["channels"]]);
  assert.equal(out.deliversTo, "Buzz #dev");
  assert.deepEqual(out.kyb.data.posts, ["Buzz #dev"]);
  assert.match(out.posts, /Buzz #dev, not in Studio/);

  const source = schedule(appRoot, "open-prs");
  const run = readRoutine(source);
  assert.deepEqual(run.delivery, { surface: "buzz", channel: "c-dev", name: "dev" });
  assert.equal(run.owner.principalId, "user_dana");
  // Marked on the owner, so the phone is not rung for a post in a room.
  assert.equal(run.owner.attributes.delivery, "buzz");
  assert.match(run.instruction, /^List the open pull requests on GitHub\.\n\n\(Your answer is posted for you as one message in Buzz #dev/);

  const listed = await tools.list_routines.execute();
  assert.equal(listed.routines.find((r) => r.name === "open-prs").deliversTo, "Buzz #dev");
});

test("a room that does not exist, or exists twice, is said when the routine is made", async () => {
  const { appRoot, tools } = agent();
  await assert.rejects(
    tools.create_routine.execute({ name: "a", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "buzz", channel: "#devops" } }, asDana),
    /No Buzz channel called #devops.*#dev, #sales, #general/,
  );
  await assert.rejects(
    tools.create_routine.execute({ name: "b", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "buzz", channel: "general" } }, asDana),
    /more than one Buzz channel called #general: c-general-1/,
  );
  // By id, the second one is fine.
  await tools.create_routine.execute({ name: "c", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "buzz", channel: "c-general-2" } }, asDana);
  assert.equal(readRoutine(schedule(appRoot, "c")).delivery.channel, "c-general-2");
  await assert.rejects(
    tools.create_routine.execute({ name: "d", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "fax" } }, asDana),
    /can deliver a routine to Studio \(the default\)/,
  );
});

test("an agent in two communities names which one the room is in", async () => {
  const { appRoot } = agent();
  const two = {
    channels: [
      { id: "c-dev", name: "dev", relay: "wss://team.example" },
      { id: "c-x", name: "random", relay: "wss://other.example" },
    ],
  };
  const tools = routineTools({ appRoot, buzzRunner: async () => JSON.stringify(two) });
  await tools.create_routine.execute({ name: "e", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "buzz", channel: "dev" } }, asDana);
  assert.deepEqual(readRoutine(schedule(appRoot, "e")).delivery, { surface: "buzz", channel: "c-dev", name: "dev", relay: "wss://team.example" });
});

test("Slack and iMessage routines start their turn on that channel", async () => {
  const { appRoot, tools } = agent({
    "agent/channels/slack.ts": "export default {}",
    "agent/channels/linq.ts": "export default {}",
    ".kyb/magic/people/user_dana/surface.json": JSON.stringify({ kind: "chat-sdk", token: "linq:linq:chat_42", auth: dana, at: "2026-10-28T00:00:00Z" }),
  });
  const slack = await tools.create_routine.execute({ name: "s", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "slack", channel: "C0123ABCD" } }, asDana);
  const source = schedule(appRoot, "s");
  assert.match(source, /import target from "\.\.\/channels\/slack\.js"/);
  assert.match(source, /to\(target, \{"channelId":"C0123ABCD"\}\)/);
  assert.match(source, /"delivery":"slack"/);
  assert.deepEqual(slack.kyb.actions.map((a) => a.routine), [undefined, undefined], "only its schedule can start a Slack turn");

  await tools.create_routine.execute({ name: "i", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "imessage" } }, asDana);
  assert.match(schedule(appRoot, "i"), /to\(target, \{"threadId":"linq:chat_42"\}\)/);
  const listed = await tools.list_routines.execute();
  assert.deepEqual(
    Object.fromEntries(listed.routines.map((r) => [r.name, r.deliversTo])),
    { s: "Slack C0123ABCD", i: "iMessage" },
  );
});

test("Slack and iMessage are refused on an agent that is not on them", async () => {
  const { tools } = agent();
  await assert.rejects(tools.create_routine.execute({ name: "s", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "slack", channel: "C0123ABCD" } }, asDana), /not on Slack/);
  await assert.rejects(tools.create_routine.execute({ name: "i", cron: "0 1 * * *", instruction: "x", deliver_to: { surface: "imessage" } }, asDana), /not on iMessage/);
});

function channel(buzzRunner) {
  const threads = mkdtempSync(join(tmpdir(), "kyb-threads-"));
  const ch = manageChannel({ appRoot: mkdtempSync(join(tmpdir(), "kyb-app-")), threads: { dir: threads }, buzzRunner });
  const sent = [];
  const from = (address) => ({
    send: async (message, options) => {
      sent.push({ address, message, options });
      return { id: "run_1" };
    },
  });
  return { ch, threads, sent, from };
}

const deliver = { surface: "buzz", channel: "c-dev", name: "dev" };
const buzzRun = { kind: "run", owner: "user_dana", routine: "open-prs", deliver };
const finished = (text) => {
  const run = newRunCapture();
  if (text) captureRunEvent(run, "message.completed", { message: text, finishReason: "stop" });
  return run;
};

test("a Buzz routine runs in the background, as its owner", async () => {
  const { ch, sent, from } = channel(async () => "{}");
  await ch.receive({ message: "List the open PRs.", target: { routine: "open-prs", deliver }, auth: { ...dana, attributes: { delivery: "buzz" } } }, { from });
  assert.match(sent[0].address, /^run:open-prs:user_dana:/);
  assert.deepEqual(sent[0].options.state, buzzRun);
  assert.equal(sent[0].options.auth.principalId, "user_dana");
});

test("its answer is posted in the room, and nothing goes to Studio", async () => {
  const threads = mkdtempSync(join(tmpdir(), "kyb-threads-"));
  const posts = [];
  const buzz = async (args, input) => {
    posts.push({ args, input });
    return "{}";
  };
  await settleRun({ owner: "user_dana", routine: "open-prs", deliver, sessionId: "run_1", run: finished("Three open PRs:\n- #12\n- #14"), threads, buzz });
  assert.deepEqual(posts, [{ args: ["post", "--channel", "c-dev"], input: "Three open PRs:\n- #12\n- #14" }]);
  assert.deepEqual(readThread(threads, "user_dana").reports, []);

  await settleRun({ owner: "user_dana", deliver: { ...deliver, relay: "wss://team.example" }, sessionId: "run_2", run: finished("x"), threads, buzz });
  assert.deepEqual(posts[1].args, ["post", "--channel", "c-dev", "--relay", "wss://team.example"]);
});

test("an answer that cannot be posted is not lost: it lands in the owner's thread, saying why", async () => {
  const threads = mkdtempSync(join(tmpdir(), "kyb-threads-"));
  const buzz = async () => {
    throw new Error("relay_membership_required");
  };
  await settleRun({ owner: "user_dana", routine: "open-prs", deliver, sessionId: "run_1", run: finished("Three open PRs."), threads, buzz });
  const [report] = readThread(threads, "user_dana").reports;
  assert.equal(report.text, "Could not post this in Buzz #dev (relay_membership_required):\n\nThree open PRs.");
  assert.equal(report.routine, "open-prs");
});

test("a Buzz routine that said nothing posts nothing; a Studio routine reports as before", async () => {
  const threads = mkdtempSync(join(tmpdir(), "kyb-threads-"));
  const posts = [];
  const buzz = async (args) => {
    posts.push(args);
    return "{}";
  };
  await settleRun({ owner: "user_dana", deliver, sessionId: "run_1", run: finished(), threads, buzz });
  assert.deepEqual(posts, []);
  await settleRun({ owner: "user_dana", routine: "brief", sessionId: "run_2", run: finished("Two meetings."), threads, buzz });
  assert.deepEqual(posts, []);
  assert.deepEqual(readThread(threads, "user_dana").reports.map((r) => r.text), ["Two meetings."]);
});
