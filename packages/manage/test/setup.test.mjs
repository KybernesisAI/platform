import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyEnvUpdate,
  classifyAuthoredReach,
  inFlightRuns,
  parseEnv,
  validateEnvUpdate,
  writeEnvFile,
} from "../dist/setup-env.js";
import { SafeRestarter, createSetupActions, firstJson, setupRoutes, vncPassword } from "../dist/setup.js";

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
  assert.ok(!status.items.find((i) => i.id === "wallet"), "no wallet item without payments");
});

test("firstJson finds the object a CLI prints between notices", () => {
  assert.deepEqual(firstJson('update available {x}\n{"a":{"b":"}"}}\nbye'), { a: { b: "}" } });
  assert.equal(firstJson("no json"), null);
});
