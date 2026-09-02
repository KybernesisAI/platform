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

const TAG = (config, app = "4c4164b5039c3606", runtime = "f8040f0426bd9e4e85f8") =>
  `eve-sbx-tpl-docker-${app}-${config}-${runtime}`;
const IMG = (tag) => `eve-sandbox-template:${tag}`;
const HOUR = 60 * 60 * 1000;

/** A daemon that holds exactly these images and answers one `docker images` listing. */
function daemonWith(images, calls = []) {
  return (_command, args) => {
    calls.push(args.join(" "));
    assert.equal(args[0], "images", "the inspector lists images once, it does not inspect them one by one");
    return { ok: true, stdout: images.join("\n") + "\n" };
  };
}

test("exe inspector matches markers to images by identity: the newest batch, one per sandbox config", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");
  sandbox(fixture.dir, "agent/subagents/builder/sandbox/sandbox.ts");
  const now = 10 * HOUR;
  // Two prewarms three days apart, as on a real host: the old set's images are
  // long gone, and that must not count against the current set.
  marker(fixture.dir, TAG("aaaa"), IMG(TAG("aaaa")), now - 72 * HOUR);
  marker(fixture.dir, TAG("bbbb"), IMG(TAG("bbbb")), now - 72 * HOUR);
  marker(fixture.dir, TAG("aaaa") + "x", IMG(TAG("aaaa") + "x"), now - 72 * HOUR); // unparseable, old
  marker(fixture.dir, TAG("aaaa", "4c4164b5039c3606", "0f0f0f0f0f0f0f0f0f0f"), IMG(TAG("aaaa", "4c4164b5039c3606", "0f0f0f0f0f0f0f0f0f0f")), now);
  marker(fixture.dir, TAG("bbbb", "4c4164b5039c3606", "0f0f0f0f0f0f0f0f0f0f"), IMG(TAG("bbbb", "4c4164b5039c3606", "0f0f0f0f0f0f0f0f0f0f")), now - 20 * 60 * 1000);
  const calls = [];

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: daemonWith(
      [IMG(TAG("aaaa", "4c4164b5039c3606", "0f0f0f0f0f0f0f0f0f0f")), IMG(TAG("bbbb", "4c4164b5039c3606", "0f0f0f0f0f0f0f0f0f0f"))],
      calls,
    ),
  });

  assert.equal(result.status, "present", JSON.stringify(result.issues));
  assert.deepEqual(result.images.sort(), [
    IMG(TAG("aaaa", "4c4164b5039c3606", "0f0f0f0f0f0f0f0f0f0f")),
    IMG(TAG("bbbb", "4c4164b5039c3606", "0f0f0f0f0f0f0f0f0f0f")),
  ]);
  assert.equal(calls.length, 1);
});

test("exe inspector does not pass a partial rebuild off as a full set", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");
  sandbox(fixture.dir, "agent/subagents/builder/sandbox/sandbox.ts");
  const now = 10 * HOUR;
  // The failure the count-based check let through: the root scope rebuilt
  // twice (two root markers on top), and "newest two markers" read as 2/2.
  marker(fixture.dir, TAG("a0a0"), IMG(TAG("a0a0")), now - 72 * HOUR);
  marker(fixture.dir, TAG("b1b1"), IMG(TAG("b1b1")), now - 72 * HOUR);
  marker(fixture.dir, TAG("a0a0", "4c4164b5039c3606", "1111111111"), IMG(TAG("a0a0", "4c4164b5039c3606", "1111111111")), now - 60 * 1000);
  marker(fixture.dir, TAG("a0a0", "4c4164b5039c3606", "2222222222"), IMG(TAG("a0a0", "4c4164b5039c3606", "2222222222")), now);

  const result = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: daemonWith([IMG(TAG("a0a0", "4c4164b5039c3606", "2222222222"))]),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "incomplete-set");
  assert.match(result.issues[0].detail, /covered 1 of 2/);
  // Only the newest root marker is judged; its image is present, so no missing-image issue.
  assert.deepEqual(result.images, [IMG(TAG("a0a0", "4c4164b5039c3606", "2222222222"))]);
});

test("exe inspector reports a current marker whose image is gone, by exact reference", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");
  marker(fixture.dir, TAG("root"), IMG(TAG("root")), 1000);

  // Kyber after the daemon-wide prune: 13 current markers, 0 images.
  const missing = await inspectDockerTemplates({ appDir: fixture.dir, runDocker: daemonWith([]) });
  assert.equal(missing.status, "failed");
  assert.equal(missing.issues[0].kind, "missing-image");
  assert.equal(missing.issues[0].subject, IMG(TAG("root")));
  assert.match(missing.issues[0].detail, /eve build/);

  // A sibling checkout's images on the same daemon do not stand in for ours.
  const sibling = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: daemonWith([IMG(TAG("root", "b2a4594584f605b0"))]),
  });
  assert.equal(sibling.status, "failed");
  assert.equal(sibling.issues[0].kind, "missing-image");

  const none = await inspectDockerTemplates({ appDir: app().dir, runDocker: daemonWith([]) });
  assert.equal(none.status, "skipped");
});

test("exe inspector treats a Docker error as a failure, not as an absence, and reports no markers at all", async (t) => {
  const fixture = app();
  t.after(fixture.cleanup);
  sandbox(fixture.dir, "agent/sandbox/sandbox.ts");

  const unbuilt = await inspectDockerTemplates({ appDir: fixture.dir, runDocker: () => ({ ok: true, stdout: "" }) });
  assert.equal(unbuilt.status, "failed");
  assert.equal(unbuilt.issues[0].kind, "missing-marker");

  marker(fixture.dir, TAG("root"), IMG(TAG("root")), 1000);
  const daemon = await inspectDockerTemplates({
    appDir: fixture.dir,
    runDocker: () => ({ ok: false, stderr: "Cannot connect to the Docker daemon" }),
  });
  assert.equal(daemon.status, "failed");
  assert.equal(daemon.issues[0].kind, "docker-error");
  assert.match(daemon.issues[0].detail, /Cannot connect/);
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
  assert.match(template?.detail ?? "", /No Docker template has been built .*1 sandbox/);
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
  write(docker, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(log)}\nprintf 'eve-sandbox-template:root\\n'\nexit 0\n`);
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
  assert.equal(await import("node:fs").then(({ readFileSync }) => readFileSync(log, "utf8").trim()), "images --filter reference=eve-sandbox-template --format {{.Repository}}:{{.Tag}}");
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
