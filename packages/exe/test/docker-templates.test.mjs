import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DOCKER_TEMPLATE_MARKER_DIRECTORY,
  inspectDockerTemplates,
} from "../dist/docker-templates.js";
import { hostPreflight } from "../dist/preflight.js";

const dockerSandbox = `
import { docker } from "eve/sandbox/docker";
export default defineSandbox({ backend: docker(), async bootstrap() {} });
`;

function app() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-exe-templates-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

function healthyFetch() {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok", { status: 200 });
  };
}

function setHealthyPreflightEnvironment(t) {
  const names = [
    "WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS",
    "WORKFLOW_LOCAL_BODY_TIMEOUT_MS",
    "BLOB_READ_WRITE_TOKEN",
    "WORKFLOW_LOCAL_BASE_URL",
    "EXE_MODEL",
    "EVE_DOCKER_PATH",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = "900000";
  process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = "900000";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  delete process.env.WORKFLOW_LOCAL_BASE_URL;
  delete process.env.EXE_MODEL;
  globalThis.fetch = healthyFetch();
  t.after(() => {
    globalThis.fetch = previousFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

test("exe inspector skips non-Docker apps without invoking Docker", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts", `
    import { docker } from "eve/sandbox/docker";
    // backend: docker()
    export default defineSandbox({ backend: exeSandbox(), async bootstrap() {} });
  `);
  let called = false;

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: () => {
      called = true;
      return { ok: true };
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(called, false);
});

test("exe inspector checks only the newest configured marker set", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");
  sandbox(fixture.dir, "agent/subagents/builder/sandbox/sandbox.ts");
  marker(fixture.dir, "stale", "eve-sandbox-template:stale", 1000);
  marker(fixture.dir, "root", "eve-sandbox-template:root", 2000);
  marker(fixture.dir, "builder", "eve-sandbox-template:builder", 2001);
  const images = [];

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: (_command, args) => {
      images.push(args[2]);
      return { ok: args[2] !== "eve-sandbox-template:stale" };
    },
  });

  assert.equal(result.status, "present");
  assert.deepEqual(images, ["eve-sandbox-template:builder", "eve-sandbox-template:root"]);
});

test("exe inspector reports exact missing images and Docker daemon errors", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");
  marker(fixture.dir, "root", "eve-sandbox-template:root-exact", 1000);

  const missing = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: () => ({ ok: false, stderr: "No such image: eve-sandbox-template:root-exact" }),
  });
  assert.equal(missing.status, "failed");
  assert.equal(missing.issues[0].subject, "eve-sandbox-template:root-exact");
  assert.equal(missing.issues[0].kind, "missing-image");
  assert.match(missing.issues[0].detail, /eve build/);

  const daemon = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: () => ({ ok: false, stderr: "Cannot connect to the Docker daemon" }),
  });
  assert.equal(daemon.status, "failed");
  assert.equal(daemon.issues[0].kind, "docker-error");
});

test("hostPreflight aggregates missing Docker template markers as failures", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  setHealthyPreflightEnvironment(t);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");

  const result = await hostPreflight({
    appDir: fixture.dir,
    llmBaseUrl: "http://127.0.0.1:9001/v1",
    eveUrl: "http://127.0.0.1:9002",
  });

  assert.equal(result.ok, false);
  const template = result.checks.find((check) => check.name.includes("Docker sandbox template unresolved"));
  assert.equal(template?.ok, false);
  assert.match(template?.detail ?? "", /agent\/sandbox\/sandbox\.ts/);
  assert.match(template?.detail ?? "", /eve build/);
  assert.match(template?.detail ?? "", /restart.*prewarm.*before serving traffic/i);
});

test("hostPreflight passes current images and honors EVE_DOCKER_PATH", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  setHealthyPreflightEnvironment(t);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");
  marker(fixture.dir, "root", "eve-sandbox-template:root", 1000);
  const docker = join(fixture.dir, "compatible-docker");
  const log = join(fixture.dir, "docker-args.log");
  write(docker, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(docker, 0o755);
  process.env.EVE_DOCKER_PATH = docker;

  const result = await hostPreflight({
    appDir: fixture.dir,
    llmBaseUrl: "http://127.0.0.1:9001/v1",
    eveUrl: "http://127.0.0.1:9002",
  });

  const template = result.checks.find((check) => check.name === "Docker sandbox templates provisioned");
  assert.equal(template?.ok, true);
  assert.equal(result.ok, true);
  assert.equal(await import("node:fs").then(({ readFileSync }) => readFileSync(log, "utf8").trim()), "image inspect eve-sandbox-template:root");
});

test("hostPreflight appends no Docker template check for non-Docker apps", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  setHealthyPreflightEnvironment(t);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts", `
    export default defineSandbox({ backend: vercel(), async bootstrap() {} });
  `);

  const result = await hostPreflight({
    appDir: fixture.dir,
    llmBaseUrl: "http://127.0.0.1:9001/v1",
    eveUrl: "http://127.0.0.1:9002",
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.some((check) => check.name.includes("Docker sandbox template")), false);
});
