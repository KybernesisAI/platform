import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { dockerTemplateDoctorChecks, inspectDockerTemplatesViaExe } from "../dist/doctor.js";

/**
 * The inspector itself is @kybernesis/exe's and is tested there. What create
 * owns is the mapping from its verdict to doctor lines, and the decision to
 * run it only where the exe package is installed.
 */

test("doctor adapter: a full set passes, a current marker with no image fails, a partial build warns", () => {
  assert.deepEqual(dockerTemplateDoctorChecks({ status: "skipped", sandboxes: [], images: [], issues: [] }), []);

  const pass = dockerTemplateDoctorChecks({
    status: "present",
    sandboxes: ["agent/sandbox/sandbox.ts", "agent/subagents/builder/sandbox/sandbox.ts"],
    images: ["eve-sandbox-template:a", "eve-sandbox-template:b"],
    issues: [],
  });
  assert.deepEqual(pass, [{ verdict: "pass", label: "Docker sandbox templates provisioned (2/2)" }]);

  const failed = dockerTemplateDoctorChecks({
    status: "failed",
    sandboxes: ["agent/sandbox/sandbox.ts", "agent/subagents/builder/sandbox/sandbox.ts"],
    images: ["eve-sandbox-template:a"],
    issues: [
      { kind: "incomplete-set", subject: "1 of 2 sandboxes", detail: "The newest template build covered 1 of 2. Run `eve build`." },
      { kind: "missing-image", subject: "eve-sandbox-template:a", detail: "Docker template image eve-sandbox-template:a is missing. Run `eve build`." },
      { kind: "docker-error", subject: "docker", detail: "Could not list Docker template images: no daemon." },
    ],
  });
  assert.deepEqual(failed.map((c) => [c.verdict, c.label]), [
    ["warn", "Docker sandbox templates incomplete: 1 of 2 sandboxes"],
    ["fail", "Docker sandbox template unavailable: eve-sandbox-template:a"],
    ["fail", "Docker sandbox template unavailable: docker"],
  ]);
  assert.match(failed[1].detail, /eve build/);
});

test("without @kybernesis/exe installed there is no template check; with it, exe's inspector runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-create-doctor-"));
  try {
    assert.equal(await inspectDockerTemplatesViaExe(dir), null);

    // A stand-in exe package: the real one is a sibling workspace here, but the
    // contract is "whatever dist/docker-templates.js exports".
    const dist = join(dir, "node_modules/@kybernesis/exe/dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "docker-templates.js"),
      "export async function inspectDockerTemplates({ appDir }) { return { status: 'present', sandboxes: [appDir], images: ['x'], issues: [] }; }\n",
    );
    const result = await inspectDockerTemplatesViaExe(dir);
    assert.equal(result?.status, "present");
    assert.deepEqual(result?.sandboxes, [resolve(dir)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
