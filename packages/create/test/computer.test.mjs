import assert from "node:assert/strict";
import { test } from "node:test";
import { computerDoctorChecks, countLiveProcesses } from "../dist/doctor.js";
import { computerPlan } from "../dist/templates.js";

const base = { configured: true, name: "acme-computer", containerState: "running", screenBound: true, vncPasswordSet: true };

test("doctor: a running computer with its screen published and a password passes clean", () => {
  const checks = computerDoctorChecks(base);
  assert.deepEqual(checks.map((c) => c.verdict), ["pass"]);
});

test("doctor: not configured means no lines at all", () => {
  assert.deepEqual(computerDoctorChecks({ ...base, configured: false }), []);
});

test("doctor: stopped and missing warn with the way back; a running computer without its screen fails", () => {
  assert.equal(computerDoctorChecks({ ...base, containerState: "stopped" })[0].verdict, "warn");
  assert.match(computerDoctorChecks({ ...base, containerState: "missing" })[0].detail, /eve build/);
  const noScreen = computerDoctorChecks({ ...base, screenBound: false });
  assert.ok(noScreen.some((c) => c.verdict === "fail" && /6080/.test(c.label)));
});

test("doctor: no VNC password is a warning that names the env var", () => {
  const checks = computerDoctorChecks({ ...base, vncPasswordSet: false });
  assert.ok(checks.some((c) => c.verdict === "warn" && /COMPUTER_VNC_PASSWORD/.test(c.detail)));
});

test("init plan: root sandbox, sighted tool, guarded browser, instructions, evals, env", () => {
  const plan = computerPlan("acme");
  const paths = plan.files.map((f) => f.path);
  for (const p of ["agent/sandbox.ts", "agent/tools/computer.ts", "agent/tools/open_browser.ts", "agent/tools/close_tabs.ts", "agent/instructions/computer.ts", "evals/computer.eval.ts"]) {
    assert.ok(paths.includes(p), p);
  }
  assert.match(plan.files.find((f) => f.path === "agent/sandbox.ts").content, /"acme-computer"/);
  assert.deepEqual(plan.deps, ["@kybernesis/computer"]);
  assert.match(plan.env, /COMPUTER_VNC_PASSWORD/);
});

test("doctor: extra display settings daemons warn, a pile that nears Xvfb's limit fails, and both say how to clear it", () => {
  assert.deepEqual(computerDoctorChecks({ ...base, settingsDaemons: 1 }).map((c) => c.verdict), ["pass"]);
  const some = computerDoctorChecks({ ...base, settingsDaemons: 3 }).find((c) => /settings daemons/.test(c.label));
  assert.equal(some.verdict, "warn");
  assert.match(some.detail, /0\.3\.1/);
  assert.match(some.detail, /docker exec acme-computer/);
  assert.equal(computerDoctorChecks({ ...base, settingsDaemons: 239 }).find((c) => /settings daemons/.test(c.label)).verdict, "fail");
  assert.ok(!computerDoctorChecks({ ...base, containerState: "stopped", settingsDaemons: 239 }).some((c) => /settings daemons/.test(c.label)));
});

test("doctor: zombies are not counted as live settings daemons", () => {
  assert.equal(countLiveProcesses("Ss\nSl\nZ\n \n"), 2);
  assert.equal(countLiveProcesses(""), 0);
});
