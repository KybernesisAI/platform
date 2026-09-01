import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DOCKER_TEMPLATE_MARKER_DIRECTORY,
  inspectDockerTemplates,
} from "../dist/docker-templates.js";
import { dockerTemplateDoctorChecks } from "../dist/doctor.js";

const dockerSandbox = `
import { docker } from "eve/sandbox/docker";
export default defineSandbox({
  backend: docker(),
  async bootstrap() {},
});
`;

function app() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-create-templates-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function write(path, content = "") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function sandbox(appDir, relativePath, source = dockerSandbox) {
  write(join(appDir, relativePath), source);
}

function marker(appDir, tag, image, mtime) {
  const path = join(appDir, DOCKER_TEMPLATE_MARKER_DIRECTORY, tag);
  write(path, image);
  const date = new Date(mtime);
  utimesSync(path, date, date);
}

function twoSandboxes(appDir) {
  sandbox(appDir, "agent/sandbox/sandbox.ts");
  sandbox(appDir, "agent/subagents/builder/sandbox/sandbox.ts");
}

test("all configured Docker templates absent produces one unresolved failure per sandbox", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  twoSandboxes(fixture.dir);
  let dockerCalls = 0;

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: () => {
      dockerCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.issues.length, 2);
  assert.match(result.issues[0].detail, /eve build/);
  assert.match(result.issues[0].detail, /restart.*prewarm.*before serving traffic/i);
  assert.equal(dockerCalls, 0);
});

test("all current exact template images present passes", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  twoSandboxes(fixture.dir);
  marker(fixture.dir, "root-tag", "eve-sandbox-template:root-current", 1000);
  marker(fixture.dir, "builder-tag", "eve-sandbox-template:builder-current", 1001);
  const inspected = [];

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: (command, args) => {
      inspected.push([command, ...args]);
      return { ok: true };
    },
  });

  assert.equal(result.status, "present");
  assert.deepEqual(result.images, [
    "eve-sandbox-template:builder-current",
    "eve-sandbox-template:root-current",
  ]);
  assert.deepEqual(inspected.map((call) => call.slice(1)), [
    ["image", "inspect", "eve-sandbox-template:builder-current"],
    ["image", "inspect", "eve-sandbox-template:root-current"],
  ]);
});

test("a missing current builder image fails by its exact reference", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  twoSandboxes(fixture.dir);
  marker(fixture.dir, "root-tag", "eve-sandbox-template:root-current", 1000);
  marker(fixture.dir, "builder-tag", "eve-sandbox-template:builder-current", 1001);

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: (_command, args) => args[2] === "eve-sandbox-template:root-current"
      ? { ok: true }
      : { ok: false, stderr: "Error response from daemon: No such image" },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "missing-image");
  assert.equal(result.issues[0].subject, "eve-sandbox-template:builder-current");
  assert.match(result.issues[0].detail, /eve-sandbox-template:builder-current/);
  assert.match(result.issues[0].detail, /eve build/);
});

test("a root marker without a builder marker still fails the builder sandbox", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  twoSandboxes(fixture.dir);
  marker(fixture.dir, "root-tag", "eve-sandbox-template:root-current", 1000);

  const result = await inspectDockerTemplates({ appDir: fixture.dir, runDocker: () => ({ ok: true }) });

  assert.equal(result.status, "failed");
  assert.equal(result.issues[0].kind, "missing-marker");
  assert.equal(result.issues[0].subject, "agent/subagents/builder/sandbox/sandbox.ts");
});

test("historical markers are excluded from the current configured set", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  twoSandboxes(fixture.dir);
  marker(fixture.dir, "stale", "eve-sandbox-template:stale", 1000);
  marker(fixture.dir, "root", "eve-sandbox-template:root-current", 2000);
  marker(fixture.dir, "builder", "eve-sandbox-template:builder-current", 2001);
  const inspected = [];

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: (_command, args) => {
      inspected.push(args[2]);
      return { ok: true };
    },
  });

  assert.equal(result.status, "present");
  assert.deepEqual(inspected, ["eve-sandbox-template:builder-current", "eve-sandbox-template:root-current"]);
  assert.equal(inspected.includes("eve-sandbox-template:stale"), false);
});

test("non-Docker backends and Docker sandboxes without reusable state skip Docker", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox.ts", `
    import { docker } from "eve/sandbox/docker";
    // backend: docker(), bootstrap() {}
    export default defineSandbox({ backend: vercel() });
  `);
  sandbox(fixture.dir, "agent/subagents/empty/sandbox/sandbox.ts", `
    import { docker } from "eve/sandbox/docker";
    export default defineSandbox({ backend: docker() });
  `);
  let called = false;

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: () => {
      called = true;
      return { ok: false };
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(called, false);
});

test("flat and recursively nested aliased Docker sandboxes are discovered", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/subagents/planner/subagents/coder/sandbox.mts", `
    import { docker as container } from "eve/sandbox/docker";
    const backend = container();
    export default defineSandbox({ backend, bootstrap() {} });
  `);

  const result = await inspectDockerTemplates({ appDir: fixture.dir, runDocker: () => ({ ok: true }) });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.sandboxes, ["agent/subagents/planner/subagents/coder/sandbox.mts"]);
});

test("non-empty sandbox workspace resources require a template without bootstrap", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts", `
    import { docker } from "eve/sandbox/docker";
    export default defineSandbox({ backend: docker() });
  `);
  write(join(fixture.dir, "agent/sandbox/workspace/seed.txt"), "seed");

  const result = await inspectDockerTemplates({ appDir: fixture.dir, runDocker: () => ({ ok: true }) });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.sandboxes, ["agent/sandbox/sandbox.ts"]);
});

test("Docker CLI or daemon errors are failures rather than skips", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");
  marker(fixture.dir, "root", "eve-sandbox-template:root", 1000);

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: () => ({ ok: false, stderr: "Cannot connect to the Docker daemon" }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.issues[0].kind, "docker-error");
  assert.match(result.issues[0].detail, /Cannot connect to the Docker daemon/);
  assert.match(result.issues[0].detail, /eve build/);
});

test("EVE_DOCKER_PATH selects the compatible Docker command", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");
  marker(fixture.dir, "root", "eve-sandbox-template:root", 1000);
  const previous = process.env.EVE_DOCKER_PATH;
  process.env.EVE_DOCKER_PATH = "/opt/podman-compatible";
  t.after(() => {
    if (previous === undefined) delete process.env.EVE_DOCKER_PATH;
    else process.env.EVE_DOCKER_PATH = previous;
  });
  let used;

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: (command) => {
      used = command;
      return { ok: true };
    },
  });

  assert.equal(result.status, "present");
  assert.equal(used, "/opt/podman-compatible");
});

test("doctor adapter emits actionable failures and a single clean pass", () => {
  const failed = dockerTemplateDoctorChecks({
    status: "failed",
    sandboxes: ["agent/sandbox/sandbox.ts"],
    images: ["eve-sandbox-template:missing"],
    issues: [{
      kind: "missing-image",
      subject: "eve-sandbox-template:missing",
      detail: "Docker template image eve-sandbox-template:missing is missing. Run `eve build`, then restart so sandbox prewarm runs before serving traffic.",
    }],
  });
  assert.equal(failed[0].verdict, "fail");
  assert.match(failed[0].label, /eve-sandbox-template:missing/);
  assert.match(failed[0].detail, /eve build/);

  const passed = dockerTemplateDoctorChecks({
    status: "present",
    sandboxes: ["root", "builder"],
    images: ["root-image", "builder-image"],
    issues: [],
  });
  assert.deepEqual(passed, [{ verdict: "pass", label: "Docker sandbox templates provisioned (2/2)" }]);
  assert.deepEqual(dockerTemplateDoctorChecks({ status: "skipped", sandboxes: [], images: [], issues: [] }), []);
});
