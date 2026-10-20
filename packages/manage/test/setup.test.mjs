import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyEnvUpdate,
  classifyAuthoredReach,
  inFlightRuns,
  parseEnv,
  resolveSwitchedReach,
  validateEnvUpdate,
  writeEnvFile,
} from "../dist/setup-env.js";
import { SafeRestarter, createSetupActions, firstJson, readSetupState, setupRoutes, setupStatus, vncPassword } from "../dist/setup.js";

const ANTHROPIC = `sk-ant-api03-${"a".repeat(40)}`;

function agentDir(deps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kyb-setup-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
  return dir;
}

test("env: only allowlisted keys, checked values, and an error never quotes the value", () => {
  const bad = validateEnvUpdate({ set: { ANTHROPIC_API_KEY: "sk-wrong-shape-secret" } });
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.error, /sk-wrong-shape-secret/);

  const unknown = validateEnvUpdate({ set: { KYBERNESIS_AGENT_CREDENTIAL: "x".repeat(40) } });
  assert.equal(unknown.ok, false, "minted keys have their own routes");
  assert.equal(validateEnvUpdate({ set: { PATH: "/tmp" } }).ok, false);
  assert.equal(validateEnvUpdate({ set: { LINQ_API_KEY: "x" } }).ok, false, "Linq keys are written only by linq.verify");
  assert.equal(validateEnvUpdate({}).ok, false, "an empty update is refused");

  assert.equal(validateEnvUpdate({ set: { EXE_MODEL: "gpt-5.6-sol" } }).ok, false, "the provider prefix is required");
  assert.equal(validateEnvUpdate({ set: { EXE_LLM_URL: "https://evil.example.com/v1" } }).ok, false);
  assert.equal(validateEnvUpdate({ set: { EXE_LLM_URL: "http://llm.int.exe.xyz/v1" } }).ok, false);

  const good = validateEnvUpdate({
    set: { EXE_MODEL: "openai/gpt-5.6-sol", EXE_LLM_URL: "https://llm.int.exe.xyz/v1", ANTHROPIC_API_KEY: ` ${ANTHROPIC} ` },
    unset: ["OPENAI_API_KEY"],
  });
  assert.equal(good.ok, true);
  assert.equal(good.update.set.ANTHROPIC_API_KEY, ANTHROPIC, "trimmed");
  assert.deepEqual(good.update.unset, ["OPENAI_API_KEY"]);
  assert.equal(validateEnvUpdate({ set: { EXE_MODEL: "openai/x" }, unset: ["EXE_MODEL"] }).ok, false);
});

test("env file: replaced in place, duplicates dropped, new keys appended, other lines kept", () => {
  const before = [
    "# model",
    'EXE_MODEL="openai/old"',
    "KEEP=1",
    "EXE_MODEL=openai/dupe",
    "export OPENAI_API_KEY=sk-gone",
    "",
  ].join("\n");
  const { text, changed } = applyEnvUpdate(before, {
    set: { EXE_MODEL: "openai/gpt-5.6-sol", ANTHROPIC_API_KEY: "sk-ant-$&$1" },
    unset: ["OPENAI_API_KEY"],
  });
  assert.deepEqual(changed.sort(), ["ANTHROPIC_API_KEY", "EXE_MODEL", "OPENAI_API_KEY"]);
  const env = parseEnv(text);
  assert.equal(env.get("EXE_MODEL"), "openai/gpt-5.6-sol");
  assert.equal(env.get("ANTHROPIC_API_KEY"), "sk-ant-$&$1", "replacement patterns are written literally");
  assert.equal(env.has("OPENAI_API_KEY"), false);
  assert.equal(env.get("KEEP"), "1");
  assert.match(text, /^# model$/m);
  assert.equal(text.match(/EXE_MODEL=/g).length, 1);

  const again = applyEnvUpdate(text, { set: { EXE_MODEL: "openai/gpt-5.6-sol" }, unset: [] });
  assert.deepEqual(again.changed, [], "re-saving the same value changes nothing");
});

test("env file is written owner-only", () => {
  const dir = agentDir();
  const path = join(dir, ".env.local");
  writeEnvFile(path, { set: { EXE_MODEL: "openai/gpt-5.6-sol" }, unset: [] });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(parseEnv(readFileSync(path, "utf8")).get("EXE_MODEL"), "openai/gpt-5.6-sol");
});

test("in flight: a recent running turn counts; timers, finished and stale runs do not", () => {
  const dir = agentDir();
  const runs = join(dir, ".eve", ".workflow-data", "runs");
  mkdirSync(runs, { recursive: true });
  const now = Date.now();
  const write = (name, run, mtime = now) => {
    const file = join(runs, `${name}.json`);
    writeFileSync(file, JSON.stringify(run));
    utimesSync(file, mtime / 1000, mtime / 1000);
  };
  const recent = new Date(now - 60_000).toISOString();
  write("timer", { status: "running", workflowName: "sessionTimeoutWorkflow", updatedAt: recent });
  write("done", { status: "completed", workflowName: "turnWorkflow", updatedAt: recent });
  write("stale", { status: "running", workflowName: "turnWorkflow", updatedAt: new Date(now - 3_600_000).toISOString() }, now - 3_600_000);
  assert.equal(inFlightRuns(dir, now), 0);
  write("live", { status: "running", workflowName: "workflow//turnWorkflow", updatedAt: recent });
  assert.equal(inFlightRuns(dir, now), 1);
  assert.equal(inFlightRuns(join(dir, "nowhere"), now), 0);
});

test("model reach is read from the source the agent is built from", () => {
  assert.equal(
    classifyAuthoredReach(`import { exeModel } from "@kybernesis/exe";\nmodel: exeModel({ model: process.env.EXE_MODEL, createOpenAI })`),
    "gateway",
  );
  assert.equal(
    classifyAuthoredReach(`import { createAnthropic } from "@ai-sdk/anthropic";\nmodel: claudeSubscription({ model: "claude-opus-5", createAnthropic })`),
    "claude-sub",
  );
  assert.equal(classifyAuthoredReach(`import { anthropic } from "eve/models/anthropic";\nmodel: anthropic()`), "byok-anthropic");
  assert.equal(classifyAuthoredReach(`import { openai } from "eve/models/openai";\nmodel: openai("gpt-6")`), "byok-openai");
  assert.equal(classifyAuthoredReach(`model: "anthropic/claude-sonnet-5"`), "other");
  assert.equal(classifyAuthoredReach(null), "unknown");
});

test("restart: none without a command; otherwise one restart, only once nothing is in flight", async () => {
  const manual = new SafeRestarter({ appRoot: "/nowhere" });
  assert.equal(manual.request().restart, "manual");

  let live = 1;
  const launched = [];
  const restarter = new SafeRestarter({
    appRoot: "/nowhere",
    restartCommand: "sudo -n systemctl restart a-agent",
    delayMs: 5,
    pollMs: 5,
    inFlight: () => live,
    launch: (script) => launched.push(script),
  });
  restarter.request("docker rm -f a-computer");
  restarter.request();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(launched.length, 0, "a conversation is in flight");
  assert.equal(restarter.state().restart, "waiting");
  live = 0;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(launched, ["{ docker rm -f a-computer || true; }; sudo -n systemctl restart a-agent"]);
  assert.equal(restarter.state().restart, "none");
});

test("vnc.password: eight characters, stored, and the computer is recreated at the restart", async () => {
  assert.match(vncPassword(), /^[A-Za-z2-9]{8}$/);
  const dir = agentDir({ "@kybernesis/computer": "^0.2.2" });
  const befores = [];
  const actions = createSetupActions({
    appRoot: dir,
    options: { computerName: "a-computer" },
    restarter: { request: (b) => (befores.push(b), { restart: "scheduled", inFlight: 0, note: "" }) },
  });
  const { status, body } = await actions.run({ action: "vnc.password" });
  assert.equal(status, 200);
  assert.equal(parseEnv(readFileSync(join(dir, ".env.local"), "utf8")).get("COMPUTER_VNC_PASSWORD"), body.password);
  assert.deepEqual(befores, ["docker rm -f a-computer"]);

  const own = await actions.run({ action: "vnc.password", password: "my-scrn7" });
  assert.equal(own.status, 200);
  assert.equal(own.body.password, "my-scrn7", "the owner's own password is used as typed");
  assert.equal(parseEnv(readFileSync(join(dir, ".env.local"), "utf8")).get("COMPUTER_VNC_PASSWORD"), "my-scrn7");
  for (const bad of ["short", "toolongpass", "has space", "q'uote", 12345678]) {
    assert.equal((await actions.run({ action: "vnc.password", password: bad })).status, 400, `refuses ${bad}`);
  }

  const none = createSetupActions({ appRoot: agentDir(), options: {}, restarter: { request() {} } });
  assert.equal((await none.run({ action: "vnc.password" })).status, 409, "no computer, nothing to rotate");
  assert.equal((await none.run({ action: "nope" })).status, 400);
});

test("linq: code emailed, then the line out; the API key is stored and never returned", async () => {
  const dir = agentDir();
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    const cmd = args.slice(2).join(" ");
    if (cmd.startsWith("signup") && !cmd.includes("--code")) {
      return { code: 0, stdout: "Check a@b.co for your verification code.\nTo complete signup, run: …", stderr: "" };
    }
    if (cmd.startsWith("signup")) return { code: 0, stdout: "API Key: linq_secret_token", stderr: "" };
    if (cmd === "tokens show --json") return { code: 0, stdout: '{ "token": "linq_secret_token" }', stderr: "" };
    if (cmd === "whoami --json") return { code: 0, stdout: '{ "phone": "+15550100" }', stderr: "" };
    if (cmd === "webhooks list --json") {
      return { code: 0, stdout: '[{"id":"old","target_url":"https://a.exe.xyz:8000/eve/v1/linq"}]', stderr: "" };
    }
    if (cmd.startsWith("webhooks delete")) return { code: 0, stdout: "{}", stderr: "" };
    if (cmd.startsWith("webhooks create")) return { code: 0, stdout: '{"id":"wh_1","signing_secret":"whsec_abc"}', stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const actions = createSetupActions({
    appRoot: dir,
    agent: "planner",
    options: { exec, publicUrl: "https://a.exe.xyz:8000" },
    restarter: { request: () => ({ restart: "scheduled", inFlight: 0, note: "" }) },
  });

  assert.equal((await actions.run({ action: "linq.signup", email: "not-an-email" })).status, 400);
  const first = await actions.run({ action: "linq.signup", email: "A@B.co" });
  assert.equal(first.status, 200);
  assert.equal(first.body.codeRequired, true);
  assert.equal((await actions.run({ action: "linq.verify", code: "12" })).status, 400);

  const done = await actions.run({ action: "linq.verify", code: "123456" });
  assert.equal(done.status, 200);
  assert.equal(done.body.number, "+15550100");
  assert.equal(done.body.channelInstalled, false);
  assert.doesNotMatch(JSON.stringify(done.body), /linq_secret_token|whsec_abc/);
  const env = parseEnv(readFileSync(join(dir, ".env.local"), "utf8"));
  assert.equal(env.get("LINQ_API_KEY"), "linq_secret_token");
  assert.equal(env.get("LINQ_WEBHOOK_SECRET"), "whsec_abc");

  const verify = calls.find((c) => c.includes("--code"));
  assert.deepEqual(verify.slice(0, 3), ["npx", "--yes", "@linqapp/cli@2.7.0"], "the CLI is pinned");
  assert.ok(verify.includes("a@b.co") && verify.includes("planner"));
  assert.ok(calls.some((c) => c.join(" ").includes("webhooks delete old")), "the earlier webhook is replaced");
  const create = calls.find((c) => c.includes("create"));
  assert.ok(create.includes("https://a.exe.xyz:8000/eve/v1/linq"));

  assert.equal((await actions.run({ action: "linq.signup", email: "a@b.co" })).status, 409, "one line per agent");
});

test("link.login: returns the approval link and phrase, and leaves a poll running to finish it", async () => {
  const dir = agentDir({ "@kybernesis/payments": "^0.3.0" });
  const launched = [];
  let argv;
  const actions = createSetupActions({
    appRoot: dir,
    agent: "planner",
    options: {
      exec: async (_file, args) => {
        argv = args;
        return { code: 0, stdout: '{"verification_url":"https://link.com/device?c=x","phrase":"apple banana"}', stderr: "" };
      },
      launch: (script) => launched.push(script),
    },
    restarter: { request() {} },
  });
  const { status, body } = await actions.run({ action: "link.login" });
  assert.equal(status, 200);
  assert.equal(body.url, "https://link.com/device?c=x");
  assert.equal(body.phrase, "apple banana");
  assert.deepEqual(argv.slice(0, 2), ["--no-install", "link-cli"], "never fetches the unrelated unscoped package");
  assert.ok(argv.includes("planner"));
  assert.match(launched[0], /link-cli auth status --interval 5/);
});

test("wallet.add: adds the payments item, rebuilds, and restarts only after a good build", async () => {
  const dir = agentDir({ "@kybernesis/computer": "^0.2.2" });
  mkdirSync(join(dir, "agent", "tools"), { recursive: true });
  writeFileSync(join(dir, "agent", "tools", "mine.ts"), "export default 1;");
  const calls = [];
  let restarts = 0;
  const actions = createSetupActions({
    appRoot: dir,
    agent: "planner",
    options: {
      exec: async (file, args) => {
        calls.push([file, ...args].join(" "));
        if (args.includes("add")) {
          writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@kybernesis/computer": "^0.2.2", "@kybernesis/payments": "^0.3.0" } }));
          writeFileSync(join(dir, "agent", "tools", "pay_on_computer.ts"), "export default 2;");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: () => (restarts++, { restart: "scheduled", inFlight: 0, note: "restarting" }) },
  });
  const { status, body } = await actions.run({ action: "wallet.add" });
  assert.equal(status, 200);
  assert.equal(body.state, "added");
  assert.deepEqual(calls, ["npx --yes eve add @kybernesis/payments --yes", "npx eve build"]);
  assert.equal(restarts, 1);
  assert.equal((await actions.run({ action: "wallet.add" })).body.state, "done", "a second press changes nothing");
  assert.equal(calls.length, 2);
});

test("wallet.add: a failed build leaves the agent exactly as it was and never restarts it", async () => {
  const dir = agentDir({ "@kybernesis/computer": "^0.2.2" });
  writeFileSync(join(dir, "package-lock.json"), '{"lock":1}');
  mkdirSync(join(dir, "agent", "tools"), { recursive: true });
  writeFileSync(join(dir, "agent", "tools", "mine.ts"), "export default 1;");
  const pkgBefore = readFileSync(join(dir, "package.json"), "utf8");
  let builds = 0;
  let restarts = 0;
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      exec: async (_file, args) => {
        if (args.includes("add")) {
          writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@kybernesis/payments": "^0.3.0" } }));
          writeFileSync(join(dir, "package-lock.json"), '{"lock":2}');
          mkdirSync(join(dir, "agent", "instructions"), { recursive: true });
          writeFileSync(join(dir, "agent", "instructions", "payments.ts"), "x");
          return { code: 0, stdout: "", stderr: "" };
        }
        builds++;
        return { code: builds === 1 ? 1 : 0, stdout: "", stderr: "type error" };
      },
    },
    restarter: { request: () => restarts++ },
  });
  const { status, body } = await actions.run({ action: "wallet.add" });
  assert.equal(status, 502);
  assert.doesNotMatch(body.error, /type error/, "build output is not shown to the customer");
  assert.equal(readFileSync(join(dir, "package.json"), "utf8"), pkgBefore);
  assert.equal(readFileSync(join(dir, "package-lock.json"), "utf8"), '{"lock":1}');
  assert.equal(existsSync(join(dir, "agent", "instructions", "payments.ts")), false);
  assert.equal(existsSync(join(dir, "agent", "tools", "mine.ts")), true, "the agent's own files are kept");
  assert.equal(builds, 2, "rebuilt as it was");
  assert.equal(restarts, 0);
});

test("wallet.add: refused without a computer to pay on", async () => {
  const actions = createSetupActions({ appRoot: agentDir({}), options: { exec: async () => assert.fail("nothing runs") }, restarter: { request() {} } });
  assert.equal((await actions.run({ action: "wallet.add" })).status, 409);
});

test("linq.add: adds the iMessage channel to an agent built without it, keeps the line, restarts after a good build", async () => {
  const dir = agentDir({ "@kybernesis/exe": "^0.17.0" });
  mkdirSync(join(dir, "agent", "channels"), { recursive: true });
  writeFileSync(join(dir, "agent", "channels", "kyb.ts"), "export default 1;");
  writeFileSync(join(dir, ".env.local"), 'LINQ_API_KEY="k"\nLINQ_WEBHOOK_SECRET="whsec_x"\n');
  const calls = [];
  let restarts = 0;
  const actions = createSetupActions({
    appRoot: dir,
    agent: "planner",
    options: {
      exec: async (file, args) => {
        calls.push([file, ...args].join(" "));
        if (args.includes("add")) writeFileSync(join(dir, "agent", "channels", "linq.ts"), "export default 2;");
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: () => (restarts++, { restart: "waiting", inFlight: 1, note: "waiting" }) },
  });
  const { status, body } = await actions.run({ action: "linq.add" });
  assert.equal(status, 200);
  assert.equal(body.state, "added");
  assert.match(body.note, /answers texts/);
  assert.deepEqual(calls, ["npx --yes eve add @kybernesis/linq --yes", "npx eve build"]);
  assert.equal(restarts, 1);
  assert.equal((await actions.run({ action: "linq.add" })).body.state, "done", "a second press changes nothing");
  assert.equal(calls.length, 2);
});

test("linq.add: a failed build removes the channel, puts env back and never restarts", async () => {
  const dir = agentDir({});
  writeFileSync(join(dir, ".env.local"), 'LINQ_API_KEY="k"\n');
  let builds = 0;
  let restarts = 0;
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      exec: async (_file, args) => {
        if (args.includes("add")) {
          mkdirSync(join(dir, "agent", "channels"), { recursive: true });
          writeFileSync(join(dir, "agent", "channels", "linq.ts"), "x");
          writeFileSync(join(dir, ".env.local"), 'LINQ_API_KEY="k"\nKYBERNESIS_AGENT=\n');
          return { code: 0, stdout: "", stderr: "" };
        }
        builds++;
        return { code: builds === 1 ? 1 : 0, stdout: "", stderr: "type error" };
      },
    },
    restarter: { request: () => restarts++ },
  });
  const { status } = await actions.run({ action: "linq.add" });
  assert.equal(status, 502);
  assert.equal(existsSync(join(dir, "agent", "channels", "linq.ts")), false);
  assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), 'LINQ_API_KEY="k"\n');
  assert.equal(builds, 2);
  assert.equal(restarts, 0);
});

test("imessage item: offers linq.add while the channel is missing, with or without a line", async () => {
  const restarter = new SafeRestarter({ appRoot: "/nonexistent" });
  const item = async (dir) => (await setupStatus({ appRoot: dir, options: {}, restarter })).items.find((i) => i.id === "imessage");
  const dir = agentDir({});
  assert.deepEqual((await item(dir)).actions, ["linq.signup", "linq.verify", "linq.add"]);
  writeFileSync(join(dir, ".env.local"), 'LINQ_API_KEY="k"\nLINQ_WEBHOOK_SECRET="whsec_x"\n');
  const lineOnly = await item(dir);
  assert.equal(lineOnly.done, false);
  assert.deepEqual(lineOnly.actions, ["linq.contacts", "linq.contact.add", "linq.contact.remove", "linq.add"]);
  assert.match(lineOnly.detail, /cannot answer it until iMessage is added/);
  mkdirSync(join(dir, "agent", "channels"), { recursive: true });
  writeFileSync(join(dir, "agent", "channels", "linq.ts"), "x");
  const both = await item(dir);
  assert.equal(both.done, true);
  assert.deepEqual(both.actions, ["linq.contacts", "linq.contact.add", "linq.contact.remove"]);
});

test("wallet item: add it when there is a computer, sign in once added, sign out once signed in", async () => {
  const restarter = new SafeRestarter({ appRoot: "/nonexistent" });
  const auth = join(mkdtempSync(join(tmpdir(), "kyb-link-")), "config.json");
  const previous = process.env.LINK_AUTH_FILE;
  process.env.LINK_AUTH_FILE = auth;
  try {
    const wallet = async (deps) =>
      (await setupStatus({ appRoot: agentDir(deps), options: {}, restarter })).items.find((i) => i.id === "wallet");
    assert.equal(await wallet({}), undefined, "no computer, no wallet");
    assert.deepEqual((await wallet({ "@kybernesis/computer": "^0.2.2" })).actions, ["wallet.add"]);
    const out = await wallet({ "@kybernesis/computer": "^0.2.2", "@kybernesis/payments": "^0.3.0" });
    assert.deepEqual([out.done, out.actions], [false, ["link.login"]]);
    writeFileSync(auth, JSON.stringify({ auth: { access_token: "tok" } }));
    const signedIn = await wallet({ "@kybernesis/computer": "^0.2.2", "@kybernesis/payments": "^0.3.0" });
    assert.deepEqual([signedIn.done, signedIn.actions], [true, ["link.logout"]]);
    assert.doesNotMatch(JSON.stringify(signedIn), /tok/);

    const dir = agentDir({ "@kybernesis/payments": "^0.3.0" });
    let argv;
    const actions = createSetupActions({
      appRoot: dir,
      options: {
        exec: async (_file, args) => {
          argv = args;
          writeFileSync(auth, JSON.stringify({ auth: null }));
          return { code: 0, stdout: '{"authenticated":false}', stderr: "" };
        },
      },
      restarter: { request() {} },
    });
    const { status, body } = await actions.run({ action: "link.logout" });
    assert.equal(status, 200);
    assert.equal(body.state, "signed-out");
    assert.deepEqual(argv.slice(0, 4), ["--no-install", "link-cli", "auth", "logout"]);
  } finally {
    if (previous === undefined) delete process.env.LINK_AUTH_FILE;
    else process.env.LINK_AUTH_FILE = previous;
  }
});

test("claude.login: link first, then the code on stdin; done only when the API authenticates", async () => {
  const api = createServer((_req, res) => res.writeHead(200).end("{}"));
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const dir = agentDir();
  writeFileSync(join(dir, "package.json"), "{}");
  const execs = [];
  let startArgs;
  // Stands in for `claude auth login`: prints the link, waits for a code on stdin.
  const fakeLogin = `
    process.stdout.write("visit: https://claude.com/cai/oauth/authorize?code=true&state=s\\nPaste code here if prompted > ");
    process.stdin.once("data", (d) => process.exit(String(d).trim() === "good#code123" ? 0 : 1));`;
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      claudeProxyName: "a-claude-subscription",
      claudeProxyPort: api.address().port,
      exec: async (file, args) => {
        execs.push([file, ...args]);
        return { code: 0, stdout: file === "docker" && args[0] === "ps" ? "abc123\n" : "", stderr: "" };
      },
      start: (file, args) => {
        startArgs = [file, ...args];
        return spawn(process.execPath, ["-e", fakeLogin]);
      },
    },
    restarter: { request() {} },
  });
  const first = await actions.run({ action: "claude.login" });
  assert.equal(first.status, 200);
  assert.match(first.body.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  assert.deepEqual(startArgs, ["docker", "exec", "-i", "a-claude-subscription", "claude", "auth", "login", "--claudeai"]);
  assert.equal((await actions.run({ action: "claude.login", login: "wrong", code: "good#code123" })).status, 409);

  const done = await actions.run({ action: "claude.login", login: first.body.login, code: "good#code123" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.state, "done");
  assert.equal(done.body.agentUsesSubscription, false);
  assert.ok(execs.some((c) => c.join(" ") === "docker restart a-claude-subscription"), "credentials load at proxy start");
  assert.ok(!execs.flat().includes("good#code123"), "the code never reaches a command line");
  api.close();
});

test("claude.login: runs up even when the proxy runs, and waits while the patched image builds", async () => {
  const dir = agentDir();
  writeFileSync(join(dir, "package.json"), "{}");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "claude-subscription.sh"), "");
  let prepareCode = 3;
  const execs = [];
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      claudeProxyName: "a-claude-subscription",
      claudeProxyPort: 1,
      exec: async (file, args, opts) => {
        execs.push({ argv: [file, ...args], env: opts.env });
        if (file === "bash" && args[1] === "prepare") return { code: prepareCode, stdout: "", stderr: "" };
        return { code: 0, stdout: file === "docker" && args[0] === "ps" ? "abc123\n" : "", stderr: "" };
      },
      start: () => spawn(process.execPath, ["-e", 'process.stdout.write("https://claude.com/cai/oauth/authorize?x=1\\n"); setTimeout(() => {}, 5000)']),
    },
    restarter: { request() {} },
  });

  const waiting = await actions.run({ action: "claude.login" });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.state, "preparing");
  assert.ok(!execs.some((c) => c.argv[2] === "up"), "no up while the image builds");

  prepareCode = 0;
  const ready = await actions.run({ action: "claude.login" });
  assert.equal(ready.body.state, "code");
  const up = execs.find((c) => c.argv[2] === "up");
  assert.ok(up, "up runs although the container is already running");
  assert.equal(up.env.CLAUDE_PROXY_NO_BUILD, undefined);

  execs.length = 0;
  prepareCode = 1;
  const fallback = await actions.run({ action: "claude.login" });
  assert.equal(fallback.body.state, "code");
  assert.equal(execs.find((c) => c.argv[2] === "up").env.CLAUDE_PROXY_NO_BUILD, "1", "a host that cannot build gets the stock proxy without a second try");
});

test("routes: every setup route asks the manage-level check, and env never echoes a value", async () => {
  const dir = agentDir();
  const routes = setupRoutes({
    prefix: "/eve/v1/kyb",
    appRoot: dir,
    options: { launch: () => {} },
    writable: () => ({ ok: true }),
    authorize: async (req) =>
      req.headers.get("authorization") === "Bearer owner" ? null : Response.json({ ok: false }, { status: 403 }),
  });
  const route = (method, path) => routes.find((r) => r.method === method && r.path === path).handler;
  const call = (method, path, body, who = "owner") =>
    route(method, path)(
      new Request(`http://agent${path}`, {
        method,
        headers: { authorization: `Bearer ${who}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );

  for (const [method, path] of [
    ["GET", "/eve/v1/kyb/setup"],
    ["POST", "/eve/v1/kyb/setup/env"],
    ["POST", "/eve/v1/kyb/setup/action"],
  ]) {
    assert.equal((await call(method, path, method === "POST" ? {} : undefined, "user")).status, 403, path);
  }

  const res = await call("POST", "/eve/v1/kyb/setup/env", { set: { ANTHROPIC_API_KEY: ANTHROPIC } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.changed, ["ANTHROPIC_API_KEY"]);
  assert.equal(body.restart.restart, "manual", "no restart command configured");
  assert.doesNotMatch(JSON.stringify(body), /sk-ant-/);

  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@kybernesis/computer": "^0.2.2" } }));
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "agent.ts"), `model: exeModel({ model: process.env.EXE_MODEL ?? "x", createOpenAI })`);
  const status = await (await call("GET", "/eve/v1/kyb/setup")).json();
  assert.equal(status.model.reach, "gateway");
  assert.equal(status.model.byok.anthropic, true);
  assert.doesNotMatch(JSON.stringify(status), /sk-ant-/);
  const model = status.items.find((i) => i.id === "model");
  assert.equal(model.done, false, "the gateway needs EXE_MODEL; a stored key the source does not use is not a model");
  assert.ok(status.items.find((i) => i.id === "computer"));
  assert.deepEqual(status.items.find((i) => i.id === "wallet").actions, ["wallet.add"], "a computer without payments can add the wallet");
});

test("firstJson finds the object a CLI prints between notices", () => {
  assert.deepEqual(firstJson('update available {x}\n{"a":{"b":"}"}}\nbye'), { a: { b: "}" } });
  assert.equal(firstJson("no json"), null);
});

const SWITCH_SOURCE = (reach) => `import { exeModelReach } from "@kybernesis/exe";
export default defineAgent({
  ...exeModelReach({ reach: "${reach}", model: "anthropic/claude-opus-5", createOpenAI, createAnthropic }),
});`;

test("KYB_MODEL_REACH: only the three routes are writable", () => {
  for (const v of ["gateway", "byok", "claude-sub"]) assert.equal(validateEnvUpdate({ set: { KYB_MODEL_REACH: v } }).ok, true, v);
  for (const v of ["", "Gateway", "openai", "claude"]) assert.equal(validateEnvUpdate({ set: { KYB_MODEL_REACH: v } }).ok, false, v);
});

test("switched reach: the same rules the agent applies at boot, including the fallback", () => {
  const env = (vars) => (k) => vars[k];
  assert.equal(resolveSwitchedReach(`model: exeModel({ model: "x", createOpenAI })`, env({})), null);
  assert.deepEqual(resolveSwitchedReach(SWITCH_SOURCE("claude-sub"), env({})), {
    switchable: true,
    authored: "claude-sub",
    reach: "claude-sub",
  });
  assert.equal(resolveSwitchedReach(SWITCH_SOURCE("claude-sub"), env({ KYB_MODEL_REACH: "gateway" })).reach, "gateway");
  assert.equal(
    resolveSwitchedReach(SWITCH_SOURCE("gateway"), env({ KYB_MODEL_REACH: "byok", ANTHROPIC_API_KEY: ANTHROPIC })).reach,
    "byok-anthropic",
  );
  assert.equal(
    resolveSwitchedReach(SWITCH_SOURCE("gateway"), env({ KYB_MODEL_REACH: "byok", EXE_MODEL: "openai/gpt-5.6", OPENAI_API_KEY: "sk-x" }))
      .reach,
    "byok-openai",
  );
  const missing = resolveSwitchedReach(SWITCH_SOURCE("gateway"), env({ KYB_MODEL_REACH: "byok" }));
  assert.equal(missing.reach, "gateway");
  assert.match(missing.fallback.reason, /needs ANTHROPIC_API_KEY/);
  const unknown = resolveSwitchedReach(SWITCH_SOURCE("claude-sub"), env({ KYB_MODEL_REACH: "nope" }));
  assert.equal(unknown.reach, "claude-sub");
  assert.match(unknown.fallback.reason, /must be one of/);
});

test("setup status: a switchable agent offers KYB_MODEL_REACH and reports what will run", async () => {
  const dir = agentDir();
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "agent.ts"), SWITCH_SOURCE("gateway"));
  writeFileSync(join(dir, ".env.local"), `KYB_MODEL_REACH=byok\nANTHROPIC_API_KEY=${ANTHROPIC}\n`);
  const routes = setupRoutes({
    prefix: "/eve/v1/kyb",
    appRoot: dir,
    options: { launch: () => {}, claudeProxyPort: 1 },
    writable: () => ({ ok: true }),
    authorize: async () => null,
  });
  const get = routes.find((r) => r.method === "GET" && r.path === "/eve/v1/kyb/setup").handler;
  const status = await (await get(new Request("http://agent/eve/v1/kyb/setup"))).json();
  assert.equal(status.model.reach, "byok-anthropic");
  assert.equal(status.model.switchable, true);
  assert.equal(status.model.authored, "gateway");
  const model = status.items.find((i) => i.id === "model");
  assert.equal(model.done, true);
  assert.ok(model.env.includes("KYB_MODEL_REACH"));
  assert.doesNotMatch(JSON.stringify(status), /sk-ant-/);

  writeFileSync(join(dir, ".env.local"), "KYB_MODEL_REACH=byok\n");
  const fellBack = await (await get(new Request("http://agent/eve/v1/kyb/setup"))).json();
  if (!process.env.ANTHROPIC_API_KEY) {
    assert.equal(fellBack.model.reach, "gateway");
    assert.equal(fellBack.model.fallback.requested, "byok");
    assert.match(fellBack.items.find((i) => i.id === "model").detail, /KYB_MODEL_REACH=byok is not used/);
  }
});

test("slack: an agent on its own control-plane Slack app reports install state from the control plane", async () => {
  const dir = agentDir();
  mkdirSync(join(dir, "agent", "channels"), { recursive: true });
  writeFileSync(join(dir, "agent", "channels", "slack.ts"), "multiplayerSlackChannel({ credentials: controlPlaneSlackCredentials({ issuer, credential }) })");
  writeFileSync(join(dir, ".env.local"), 'KYBERNESIS_ISSUER="https://cp.example"\nKYBERNESIS_AGENT_CREDENTIAL="cred"\n');
  const realFetch = globalThis.fetch;
  const seen = [];
  let answer = { status: 200, body: { signingSecret: "s", botToken: null } };
  globalThis.fetch = async (url, init) => {
    seen.push([String(url), init?.headers?.authorization]);
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  try {
    const status = async () =>
      (await setupStatus({ appRoot: dir, options: { claudeProxyPort: 1 }, restarter: new SafeRestarter({ appRoot: dir }) })).items.find((i) => i.id === "slack");
    let slack = await status();
    assert.equal(slack.done, false);
    assert.match(slack.detail, /ready to add/);
    assert.deepEqual(slack.env, [], "no Slack keys belong on this host");
    answer = { status: 200, body: { signingSecret: "s", botToken: "xoxb-1" } };
    slack = await status();
    assert.equal(slack.done, true);
    assert.doesNotMatch(JSON.stringify(slack), /xoxb/);
    answer = { status: 404, body: {} };
    assert.match((await status()).detail, /not been made/);
    assert.ok(seen.some(([url, auth]) => url === "https://cp.example/api/agent/slack" && auth === "Bearer cred"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("linq contacts: list, add and remove on a shared line; a dedicated line has no list", async () => {
  const dir = agentDir();
  const calls = [];
  let shared = true;
  const exec = async (file, args) => {
    calls.push(args.slice(2).join(" "));
    const cmd = args.slice(2).join(" ");
    if (!shared) return { code: 2, stdout: "", stderr: "Error: This command is for Shared line accounts only." };
    if (cmd === "contacts list --json") {
      return { code: 0, stdout: '{"contacts":[{"contactPhone":"+12025551234","createdAt":"2026-10-14T08:00:00.000Z"}]}', stderr: "" };
    }
    if (cmd.startsWith("contacts add")) return { code: 0, stdout: '{"contactPhone":"+12025559876","linqNumber":"+15550100","shareLink":"https://linqapp.com/s/text/x"}', stderr: "" };
    if (cmd.startsWith("contacts remove")) return { code: 0, stdout: "{}", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const actions = createSetupActions({ appRoot: dir, options: { exec }, restarter: { request() {} } });

  const listed = await actions.run({ action: "linq.contacts" });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.shared, true);
  assert.deepEqual(listed.body.contacts, [{ phone: "+12025551234", addedAt: "2026-10-14T08:00:00.000Z" }]);

  assert.equal((await actions.run({ action: "linq.contact.add", phone: "202 555 9876" })).status, 400, "needs the country code");
  assert.equal((await actions.run({ action: "linq.contact.add", phone: "+1; rm -rf /" })).status, 400);
  const added = await actions.run({ action: "linq.contact.add", phone: "+1 (202) 555-9876" });
  assert.equal(added.status, 200);
  assert.equal(added.body.phone, "+12025559876");
  assert.equal(added.body.shareLink, "https://linqapp.com/s/text/x");
  assert.ok(calls.includes("contacts add +12025559876 --json"), "the number reaches the CLI normalised");

  assert.equal((await actions.run({ action: "linq.contact.remove", phone: "+12025559876" })).status, 200);

  shared = false;
  const dedicated = await actions.run({ action: "linq.contacts" });
  assert.equal(dedicated.status, 200);
  assert.equal(dedicated.body.shared, false);
  assert.equal((await actions.run({ action: "linq.contact.add", phone: "+12025559876" })).status, 409);
});

test("grok-sub: writable, and it runs only once Grok is signed in on the host", () => {
  assert.equal(validateEnvUpdate({ set: { KYB_MODEL_REACH: "grok-sub" } }).ok, true);
  assert.equal(validateEnvUpdate({ set: { GROK_MODEL: "grok-4.6" } }).ok, true);
  assert.equal(validateEnvUpdate({ set: { GROK_MODEL: "xai/grok-4.6" } }).ok, false, "bare xAI ids only");
  const env = (vars) => (k) => vars[k];
  assert.deepEqual(resolveSwitchedReach(SWITCH_SOURCE("gateway"), env({ KYB_MODEL_REACH: "grok-sub" }), { grok: () => true }), {
    switchable: true,
    authored: "gateway",
    reach: "grok-sub",
  });
  const out = resolveSwitchedReach(SWITCH_SOURCE("gateway"), env({ KYB_MODEL_REACH: "grok-sub" }), { grok: () => false });
  assert.equal(out.reach, "gateway");
  assert.match(out.fallback.reason, /grok login/);
  assert.equal(classifyAuthoredReach(`model: grokSubscription({ model: "grok-4.6", createOpenAI })`), "grok-sub");
});

test("grok.login: link and code first, waiting while the device sign-in runs, done once the credential lands", async () => {
  const dir = agentDir();
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "agent.ts"), SWITCH_SOURCE("gateway"));
  const auth = join(dir, "grok-auth.json");
  const previous = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = auth;
  try {
    let startArgs;
    // Stands in for `grok login`: prints a link and a code, then exits once the credential exists.
    const fakeLogin = `
      process.stdout.write("\\u001b[1mOpen https://accounts.x.ai/device?user_code=ABCD-EFGH.\\u001b[0m\\nCode: ABCD-EFGH\\n");
      const fs = require("fs");
      const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(auth)})) { clearInterval(t); process.exit(0); } }, 50);`;
    const actions = createSetupActions({
      appRoot: dir,
      options: {
        exec: async () => ({ code: 0, stdout: "/usr/local/bin/grok\n", stderr: "" }),
        start: (file, args) => {
          startArgs = [file, ...args];
          return spawn(process.execPath, ["-e", fakeLogin]);
        },
      },
      restarter: { request() {} },
    });
    const first = await actions.run({ action: "grok.login" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.state, "device");
    assert.equal(first.body.url, "https://accounts.x.ai/device?user_code=ABCD-EFGH");
    assert.equal(first.body.code, "ABCD-EFGH");
    assert.deepEqual(startArgs, ["/usr/local/bin/grok", "login"]);

    assert.equal((await actions.run({ action: "grok.login", login: "wrong" })).status, 409);
    assert.equal((await actions.run({ action: "grok.login", login: first.body.login })).body.state, "waiting");

    writeFileSync(auth, JSON.stringify({ "https://auth.x.ai::c": { key: "k".repeat(64) } }));
    await new Promise((r) => setTimeout(r, 300));
    const done = await actions.run({ action: "grok.login", login: first.body.login });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.state, "done");
    assert.equal(done.body.agentUsesSubscription, false);
    assert.match(done.body.note, /KYB_MODEL_REACH=grok-sub/);
    assert.doesNotMatch(JSON.stringify(done.body), /kkkk/);

    const routes = setupRoutes({
      prefix: "/eve/v1/kyb",
      appRoot: dir,
      options: { launch: () => {}, claudeProxyPort: 1 },
      writable: () => ({ ok: true }),
      authorize: async () => null,
    });
    writeFileSync(join(dir, ".env.local"), "KYB_MODEL_REACH=grok-sub\n");
    const get = routes.find((r) => r.method === "GET" && r.path === "/eve/v1/kyb/setup").handler;
    const status = await (await get(new Request("http://agent/eve/v1/kyb/setup"))).json();
    assert.equal(status.model.grok, "signed-in");
    assert.equal(status.model.reach, "grok-sub");
    const model = status.items.find((i) => i.id === "model");
    assert.equal(model.done, true);
    assert.ok(model.actions.includes("grok.login"));
    assert.doesNotMatch(JSON.stringify(status), /kkkk/);
  } finally {
    if (previous === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previous;
  }
});

const CHATGPT_SOURCE = `import { chatgpt } from "eve/models/openai";
import { exeModelReach } from "@kybernesis/exe";
export default defineAgent({
  ...exeModelReach({ reach: "gateway", model: "openai/gpt-6-sol", createOpenAI, createAnthropic, chatgpt }),
});`;

test("chatgpt-sub: writable, needs an agent that passes chatgpt, and runs only once Codex is signed in", () => {
  assert.equal(validateEnvUpdate({ set: { KYB_MODEL_REACH: "chatgpt-sub" } }).ok, true);
  assert.equal(validateEnvUpdate({ set: { CHATGPT_MODEL: "gpt-6-sol" } }).ok, true);
  assert.equal(validateEnvUpdate({ set: { CHATGPT_MODEL: "openai/gpt-6-sol" } }).ok, false);
  const env = (vars) => (k) => vars[k];
  const on = env({ KYB_MODEL_REACH: "chatgpt-sub" });
  assert.equal(resolveSwitchedReach(CHATGPT_SOURCE, on, { chatgpt: () => true }).reach, "chatgpt-sub");
  const notSignedIn = resolveSwitchedReach(CHATGPT_SOURCE, on, { chatgpt: () => false });
  assert.equal(notSignedIn.reach, "gateway");
  assert.match(notSignedIn.fallback.reason, /codex login --device-auth/);
  const oldScaffold = resolveSwitchedReach(SWITCH_SOURCE("gateway"), on, { chatgpt: () => true });
  assert.equal(oldScaffold.reach, "gateway");
  assert.match(oldScaffold.fallback.reason, /passes chatgpt/);
  assert.equal(classifyAuthoredReach(`import { chatgpt } from "eve/models/openai";\nmodel: chatgpt()`), "chatgpt-sub");
});

test("chatgpt.login: installs codex when missing, runs the device sign-in, done once Codex has a token", async () => {
  const dir = agentDir();
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "agent.ts"), CHATGPT_SOURCE);
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const execs = [];
    let installed = false;
    let startArgs;
    // The shape codex 0.162.1 prints for --device-auth.
    const fakeLogin = `
      process.stdout.write("Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n   \\u001b[94mhttps://auth.openai.com/codex/device\\u001b[0m\\n\\n2. Enter this one-time code \\u001b[90m(expires in 15 minutes)\\u001b[0m\\n   \\u001b[94mQ7RT-9KZPM\\u001b[0m\\n");
      const fs = require("fs");
      const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(codexHome, "auth.json"))})) { clearInterval(t); process.exit(0); } }, 50);`;
    const actions = createSetupActions({
      appRoot: dir,
      options: {
        exec: async (file, args) => {
          execs.push([file, ...args]);
          if (file === "sudo") {
            installed = true;
            return { code: 0, stdout: "", stderr: "" };
          }
          return installed ? { code: 0, stdout: "/usr/bin/codex\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
        },
        start: (file, args) => {
          startArgs = [file, ...args];
          return spawn(process.execPath, ["-e", fakeLogin]);
        },
      },
      restarter: { request() {} },
    });
    const first = await actions.run({ action: "chatgpt.login" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(execs.some((c) => c.join(" ") === "sudo -n npm install -g @openai/codex@0.162.1"));
    assert.deepEqual(startArgs, ["/usr/bin/codex", "login", "--device-auth"]);
    assert.equal(first.body.url, "https://auth.openai.com/codex/device");
    assert.equal(first.body.code, "Q7RT-9KZPM");
    assert.match(first.body.instructions, /one-time code/);
    assert.equal((await actions.run({ action: "chatgpt.login", login: first.body.login })).body.state, "waiting");

    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "t".repeat(40) } }));
    await new Promise((r) => setTimeout(r, 300));
    const done = await actions.run({ action: "chatgpt.login", login: first.body.login });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.state, "done");
    assert.match(done.body.note, /KYB_MODEL_REACH=chatgpt-sub/);
    assert.doesNotMatch(JSON.stringify(done.body), /tttt/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

/** An agent on its own host, registered with the control plane. */
function hostedAgentDir(deps = {}) {
  const dir = agentDir(deps);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "eve-server.sh"), "#!/bin/bash\n");
  writeFileSync(join(dir, ".env.local"), 'KYBERNESIS_AGENT_CREDENTIAL="cred"\n');
  return dir;
}

const CP_SLACK = 'import { controlPlaneSlackCredentials } from "@kybernesis/multiplayer/slack";\n';
const withDep = (dir, name) => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.dependencies = { ...pkg.dependencies, [name]: "^1.0.0" };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
};

test("slack.add: writes the control-plane Slack channel with the Kybernesis CLI, builds, restarts once", async () => {
  const dir = hostedAgentDir();
  const calls = [];
  let restarts = 0;
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      exec: async (file, args) => {
        calls.push([file, ...args].join(" "));
        if (args.includes("channel")) {
          mkdirSync(join(dir, "agent", "channels"), { recursive: true });
          writeFileSync(join(dir, "agent", "channels", "slack.ts"), CP_SLACK);
          withDep(dir, "@kybernesis/multiplayer");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: () => (restarts++, { restart: "now" }) },
  });
  const { status, body } = await actions.run({ action: "slack.add" });
  assert.equal(status, 200);
  assert.equal(body.state, "added");
  assert.match(body.note, /Slack app is made next/);
  assert.deepEqual(calls, ["npx --yes --package=@kybernesis/create@latest kyb add channel slack", "npx eve build"]);
  assert.equal(restarts, 1);
  assert.equal((await actions.run({ action: "slack.add" })).body.state, "done");
  assert.equal(calls.length, 2);
});

test("slack.add: a channel that is not the control-plane one is rolled back; no host or no credential is refused", async () => {
  const dir = hostedAgentDir();
  let restarts = 0;
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      exec: async (_file, args) => {
        if (args.includes("channel")) {
          mkdirSync(join(dir, "agent", "channels"), { recursive: true });
          writeFileSync(join(dir, "agent", "channels", "slack.ts"), "export default 1;\n");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: () => restarts++ },
  });
  assert.equal((await actions.run({ action: "slack.add" })).status, 502);
  assert.equal(existsSync(join(dir, "agent", "channels", "slack.ts")), false);
  assert.equal(restarts, 0);

  const exec = async () => assert.fail("nothing runs");
  const vercel = createSetupActions({ appRoot: agentDir(), options: { exec }, restarter: { request() {} } });
  assert.equal((await vercel.run({ action: "slack.add" })).status, 409);
  const unregistered = hostedAgentDir();
  writeFileSync(join(unregistered, ".env.local"), "");
  const previous = process.env.KYBERNESIS_AGENT_CREDENTIAL;
  delete process.env.KYBERNESIS_AGENT_CREDENTIAL;
  try {
    const none = createSetupActions({ appRoot: unregistered, options: { exec }, restarter: { request() {} } });
    assert.equal((await none.run({ action: "slack.add" })).status, 409);
  } finally {
    if (previous !== undefined) process.env.KYBERNESIS_AGENT_CREDENTIAL = previous;
  }
});

test("slack item: offers slack.add only to a registered agent on its own host with no Slack channel", async () => {
  const restarter = new SafeRestarter({ appRoot: "/nonexistent" });
  const item = async (dir) => (await setupStatus({ appRoot: dir, options: {}, restarter })).items.find((i) => i.id === "slack");
  assert.deepEqual((await item(hostedAgentDir())).actions, ["slack.add"]);
  assert.deepEqual((await item(agentDir())).actions, [], "not on its own host");
  const withLegacy = hostedAgentDir();
  mkdirSync(join(withLegacy, "agent", "channels"), { recursive: true });
  writeFileSync(join(withLegacy, "agent", "channels", "slack.ts"), "export default 1;\n");
  assert.deepEqual((await item(withLegacy)).actions, []);
});

const settle = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
};

test("buzz.add: answers at once, runs kyb add buzz and a build, then restarts once; the item reports it", async () => {
  const dir = hostedAgentDir();
  const restarter = new SafeRestarter({ appRoot: "/nonexistent" });
  const buzzItem = async () => (await setupStatus({ appRoot: dir, options: {}, restarter })).items.find((i) => i.id === "buzz");
  assert.deepEqual([(await buzzItem()).actions, (await buzzItem()).detail], [["buzz.add"], "Not in Buzz yet."]);

  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let restarts = 0;
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      exec: async (file, args) => {
        calls.push([file, ...args].join(" "));
        if (args.includes("buzz") && args.includes("add")) {
          await gate;
          mkdirSync(join(dir, "agent", "extensions"), { recursive: true });
          writeFileSync(join(dir, "agent", "extensions", "buzz.ts"), "export { default } from '@kybernesis/buzz/extension';\n");
          withDep(dir, "@kybernesis/buzz");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: () => (restarts++, { restart: "now" }) },
  });
  const first = await actions.run({ action: "buzz.add" });
  assert.equal(first.status, 202);
  assert.equal(first.body.state, "adding");
  const busy = await buzzItem();
  assert.equal(busy.busy, true);
  assert.match(busy.detail, /Adding Buzz/);
  assert.equal((await actions.run({ action: "buzz.add" })).status, 202, "a second press while it runs starts nothing");
  assert.equal((await actions.run({ action: "linq.add" })).status, 409, "one add at a time");
  release();
  await settle(() => restarts === 1);
  assert.deepEqual(calls, ["npx --yes --package=@kybernesis/create@latest kyb add buzz", "npx eve build"]);
  assert.equal(readSetupState(dir).buzzAdd, undefined);
  assert.equal((await actions.run({ action: "buzz.add" })).body.state, "done");
});

test("buzz.add: a failed build puts the agent back, never restarts, and the item says why", async () => {
  const dir = hostedAgentDir();
  let builds = 0;
  let restarts = 0;
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      exec: async (_file, args) => {
        if (args.includes("buzz")) {
          mkdirSync(join(dir, "agent", "extensions"), { recursive: true });
          writeFileSync(join(dir, "agent", "extensions", "buzz.ts"), "x");
          withDep(dir, "@kybernesis/buzz");
          return { code: 0, stdout: "", stderr: "" };
        }
        builds++;
        return { code: builds === 1 ? 1 : 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: () => restarts++ },
  });
  assert.equal((await actions.run({ action: "buzz.add" })).status, 202);
  await settle(() => Boolean(readSetupState(dir).buzzAdd?.error));
  assert.equal(existsSync(join(dir, "agent", "extensions", "buzz.ts")), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["@kybernesis/buzz"], undefined);
  assert.equal(restarts, 0);
  const item = (await setupStatus({ appRoot: dir, options: {}, restarter: new SafeRestarter({ appRoot: "/nonexistent" }) })).items.find((i) => i.id === "buzz");
  assert.match(item.detail, /did not build with Buzz/);
  assert.equal(item.busy, undefined);

  writeFileSync(join(dir, ".kyb-setup.json"), JSON.stringify({ buzzAdd: { startedAt: "2026-10-15T00:00:00Z", pid: -1 } }));
  const interrupted = (await setupStatus({ appRoot: dir, options: {}, restarter: new SafeRestarter({ appRoot: "/nonexistent" }) })).items.find((i) => i.id === "buzz");
  assert.match(interrupted.detail, /interrupted/);
});

test("voice item: shown once voice is installed, done once the owner's key is stored", async () => {
  const restarter = new SafeRestarter({ appRoot: "/nonexistent" });
  const key = `sk-proj-${"v".repeat(40)}`;
  const previous = process.env.KYBERNESIS_VOICE_OPENAI_KEY;
  delete process.env.KYBERNESIS_VOICE_OPENAI_KEY;
  try {
    const voice = async (dir) => (await setupStatus({ appRoot: dir, options: {}, restarter })).items.find((i) => i.id === "voice");
    assert.equal(await voice(agentDir({})), undefined, "no voice package, no voice item");
    const dir = agentDir({ "@kybernesis/voice": "^0.2.1" });
    const before = await voice(dir);
    assert.deepEqual([before.done, before.env], [false, ["KYBERNESIS_VOICE_OPENAI_KEY"]]);
    // The provisioner leaves the key empty until the owner adds it.
    writeFileSync(join(dir, ".env.local"), 'KYBERNESIS_VOICE_OPENAI_KEY=""\n');
    assert.equal((await voice(dir)).done, false);
    const update = validateEnvUpdate({ set: { KYBERNESIS_VOICE_OPENAI_KEY: key } });
    assert.equal(update.ok, true);
    writeEnvFile(join(dir, ".env.local"), update.update);
    const after = await voice(dir);
    assert.equal(after.done, true);
    assert.doesNotMatch(JSON.stringify(after), new RegExp(key));
    assert.equal(validateEnvUpdate({ set: { KYBERNESIS_VOICE_OPENAI_KEY: "not-a-key" } }).ok, false);
  } finally {
    if (previous === undefined) delete process.env.KYBERNESIS_VOICE_OPENAI_KEY;
    else process.env.KYBERNESIS_VOICE_OPENAI_KEY = previous;
  }
});

// ── Updating to the newest certified packages ─────────────────────────────

function installed(dir, name, version) {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
}

function updatableAgent() {
  const dir = hostedAgentDir({ eve: "0.68.0", "@kybernesis/manage": "^0.22.0", "@kybernesis/buzz": "^0.10.0", zod: "^4.0.0" });
  writeFileSync(join(dir, "package-lock.json"), "old lock\n");
  mkdirSync(join(dir, "agent", "tools"), { recursive: true });
  writeFileSync(join(dir, "agent", "agent.ts"), "export default {};\n");
  installed(dir, "eve", "0.68.0");
  installed(dir, "@kybernesis/manage", "0.22.0");
  installed(dir, "@kybernesis/buzz", "0.10.0");
  return dir;
}

const PLAN = (changes, resetsConversations = false) =>
  `kyb upgrade — checking\nKYB_UPGRADE_PLAN ${JSON.stringify({ ok: true, eve: { installed: "0.68.0", certified: "0.68.0" }, changes, resetsConversations })}\n`;

/** What `kyb upgrade` does to the files: new ranges, a new lock, a repaired tool, newer node_modules. */
function upgradeFiles(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.dependencies["@kybernesis/manage"] = "^0.23.0";
  pkg.dependencies["@kybernesis/buzz"] = "^0.11.0";
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(dir, "package-lock.json"), "new lock\n");
  writeFileSync(join(dir, "agent", "agent.ts"), "export default { repaired: true };\n");
  writeFileSync(join(dir, "agent", "tools", "added.ts"), "export default {};\n");
  installed(dir, "@kybernesis/manage", "0.23.0");
  installed(dir, "@kybernesis/buzz", "0.11.0");
}

test("update.check: asks kyb for its plan with a clean environment, keeps it, and the item shows it until the agent changes", async () => {
  const dir = updatableAgent();
  const restarter = new SafeRestarter({ appRoot: "/nonexistent" });
  const status = async () => setupStatus({ appRoot: dir, options: {}, restarter });
  assert.equal((await status()).update.changes, null);
  assert.deepEqual((await status()).update.installed.map((p) => `${p.name}@${p.version}`), ["eve@0.68.0", "@kybernesis/buzz@0.10.0", "@kybernesis/manage@0.22.0"]);
  assert.match((await status()).items.find((i) => i.id === "update").detail, /Not checked/);

  const calls = [];
  const actions = createSetupActions({
    appRoot: dir,
    options: {
      exec: async (file, args, opts) => {
        calls.push({ cmd: [file, ...args].join(" "), clean: opts.clean });
        return { code: 0, stdout: PLAN([{ name: "@kybernesis/manage", from: "0.22.0", to: "0.23.0" }]), stderr: "" };
      },
    },
    restarter,
  });
  const checked = await actions.run({ action: "update.check" });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.state, "available");
  assert.deepEqual(calls, [{ cmd: "npx --yes --package=@kybernesis/create@>=0.24.0 kyb upgrade --check", clean: true }]);
  const after = await status();
  assert.deepEqual(after.update.changes, [{ name: "@kybernesis/manage", from: "0.22.0", to: "0.23.0" }]);
  assert.match(after.items.find((i) => i.id === "update").detail, /An update is ready: manage/);

  installed(dir, "@kybernesis/manage", "0.22.1");
  assert.equal((await status()).update.changes, null, "someone updated it by hand: the old check no longer holds");

  const broken = createSetupActions({ appRoot: dir, options: { exec: async () => ({ code: 1, stdout: "nope", stderr: "" }) }, restarter });
  assert.equal((await broken.run({ action: "update.check" })).status, 502);

  assert.equal((await setupStatus({ appRoot: agentDir(), options: {}, restarter })).update, undefined, "not on its own host: no update");
});

test("update.run: answers at once, upgrades with the eval gate, builds, restarts once (and the bridge, since Buzz moved)", async () => {
  const dir = updatableAgent();
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const restarts = [];
  const actions = createSetupActions({
    appRoot: dir,
    agent: "acme",
    options: {
      exec: async (file, args, opts) => {
        const cmd = [file, ...args].join(" ");
        calls.push(cmd);
        if (cmd.includes("systemctl show")) return { code: 0, stdout: "loaded\n", stderr: "" };
        if (cmd.includes("systemctl is-active")) return { code: 0, stdout: "active\n", stderr: "" };
        if (cmd.includes("kyb upgrade")) {
          assert.equal(opts.clean, true, "PORT from the agent's own process would collide with the eval's dev server");
          await gate;
          upgradeFiles(dir);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: (before) => (restarts.push(before), { restart: "scheduled" }) },
  });
  const first = await actions.run({ action: "update.run" });
  assert.equal(first.status, 202);
  const item = async () => (await setupStatus({ appRoot: dir, options: {}, restarter: new SafeRestarter({ appRoot: "/nonexistent" }) })).items.find((i) => i.id === "update");
  assert.equal((await item()).busy, true);
  assert.equal((await actions.run({ action: "update.run" })).status, 202, "a second press starts nothing");
  assert.equal((await actions.run({ action: "linq.add" })).status, 409, "nothing is added during an update");
  release();
  await settle(() => restarts.length === 1);
  assert.ok(calls.includes("npx --yes --package=@kybernesis/create@>=0.24.0 kyb upgrade --yes"), "no --skip-eval");
  assert.ok(!calls.some((c) => c.includes("--skip-eval")));
  assert.equal(calls.filter((c) => c === "npx eve build").length, 1);
  assert.deepEqual(restarts, ["sudo -n systemctl try-restart acme-buzz-bridge"]);
  await settle(() => readSetupState(dir).update?.startedAt === undefined);
  const state = readSetupState(dir).update;
  assert.deepEqual(state.updated.map((c) => `${c.name} ${c.from} ${c.to}`), ["@kybernesis/buzz 0.10.0 0.11.0", "@kybernesis/manage 0.22.0 0.23.0"]);
  const done = await item();
  assert.equal(done.detail, "Up to date.");
  assert.equal(done.busy, undefined);
  assert.ok(existsSync(join(dir, ".kyb-update.log")));
});

test("update.run: failed evals put every file back, reinstall the old tree, rebuild, keep the bridge up, and never restart", async () => {
  const dir = updatableAgent();
  const pkgBefore = readFileSync(join(dir, "package.json"), "utf8");
  const calls = [];
  let restarts = 0;
  let bridgeUp = true;
  const actions = createSetupActions({
    appRoot: dir,
    agent: "acme",
    options: {
      exec: async (file, args) => {
        const cmd = [file, ...args].join(" ");
        calls.push(cmd);
        if (cmd.includes("systemctl show")) return { code: 0, stdout: "loaded\n", stderr: "" };
        if (cmd.includes("systemctl is-active")) return { code: 0, stdout: bridgeUp ? "active\n" : "inactive\n", stderr: "" };
        if (cmd.includes("kyb upgrade")) {
          upgradeFiles(dir);
          bridgeUp = false;
          return { code: 1, stdout: "✗ Evals failed after upgrade. Do NOT deploy", stderr: "" };
        }
        if (cmd.startsWith("sudo -n systemctl start")) bridgeUp = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: () => restarts++ },
  });
  assert.equal((await actions.run({ action: "update.run" })).status, 202);
  await settle(() => Boolean(readSetupState(dir).update?.error));
  assert.match(readSetupState(dir).update.error, /did not pass the agent's checks/);
  assert.equal(readFileSync(join(dir, "package.json"), "utf8"), pkgBefore);
  assert.equal(readFileSync(join(dir, "package-lock.json"), "utf8"), "old lock\n");
  assert.equal(readFileSync(join(dir, "agent", "agent.ts"), "utf8"), "export default {};\n");
  assert.equal(existsSync(join(dir, "agent", "tools", "added.ts")), false);
  assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), 'KYBERNESIS_AGENT_CREDENTIAL="cred"\n');
  const after = calls.slice(calls.findIndex((c) => c.includes("kyb upgrade")) + 1);
  assert.deepEqual(after.filter((c) => !c.includes("systemctl show") && !c.includes("is-active")), [
    "npm ci --no-audit --no-fund",
    "npx eve build",
    "sudo -n systemctl start acme-buzz-bridge",
  ]);
  assert.equal(restarts, 0);
  assert.equal(bridgeUp, true);
  const item = (await setupStatus({ appRoot: dir, options: {}, restarter: new SafeRestarter({ appRoot: "/nonexistent" }) })).items.find((i) => i.id === "update");
  assert.match(item.detail, /did not pass/);
});

test("update.run: a failed build is put back; an update that changed nothing neither builds nor restarts", async () => {
  const dir = updatableAgent();
  let restarts = 0;
  let builds = 0;
  const failing = createSetupActions({
    appRoot: dir,
    options: {
      exec: async (_file, args) => {
        if (args.includes("upgrade")) upgradeFiles(dir);
        if (args.includes("build")) builds++;
        return { code: args.includes("build") && builds === 1 ? 1 : 0, stdout: "", stderr: "" };
      },
    },
    restarter: { request: () => restarts++ },
  });
  await failing.run({ action: "update.run" });
  await settle(() => Boolean(readSetupState(dir).update?.error));
  assert.match(readSetupState(dir).update.error, /did not build/);
  assert.equal(readFileSync(join(dir, "package-lock.json"), "utf8"), "old lock\n");
  assert.equal(restarts, 0);

  const quiet = [];
  const nothing = createSetupActions({
    appRoot: updatableAgent(),
    options: { exec: async (file, args) => (quiet.push([file, ...args].join(" ")), { code: 0, stdout: "Everything is at latest certified versions.", stderr: "" }) },
    restarter: { request: () => restarts++ },
  });
  await nothing.run({ action: "update.run" });
  await settle(() => quiet.length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!quiet.includes("npx eve build"));
  assert.equal(restarts, 0);
});
