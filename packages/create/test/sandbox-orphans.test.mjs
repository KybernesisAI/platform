import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TEMPLATE_CONTAINER_PROBE,
  assessRestart,
  buildingTemplates,
  orphanedTemplates,
  parseTemplateContainers,
  removeOrphanCommand,
  templateContainerDoctorChecks,
} from "../dist/sandbox-orphans.js";

/**
 * One probe feeds three places (doctor, the deploy wait, the start script):
 * for each eve-sbx-tpl-* container, its name and how many processes inside it
 * are not `sleep`. Everything below is the reading of that probe.
 */

test("the probe output parses into containers; anything that is not a template line is ignored", () => {
  const parsed = parseTemplateContainers("eve-sbx-tpl-abc 3\neve-sbx-tpl-def 0\nsomething else\n\n");
  assert.deepEqual(parsed, [
    { name: "eve-sbx-tpl-abc", liveProcesses: 3 },
    { name: "eve-sbx-tpl-def", liveProcesses: 0 },
  ]);
  assert.deepEqual(parseTemplateContainers(""), []);
  assert.deepEqual(parseTemplateContainers(null), []);
  assert.match(TEMPLATE_CONTAINER_PROBE, /command -v docker/);
  assert.match(TEMPLATE_CONTAINER_PROBE, /eve-sbx-tpl-/);
});

test("only sleep inside means orphaned; a live process means building", () => {
  const containers = parseTemplateContainers("eve-sbx-tpl-abc 3\neve-sbx-tpl-def 0");
  assert.deepEqual(orphanedTemplates(containers).map((c) => c.name), ["eve-sbx-tpl-def"]);
  assert.deepEqual(buildingTemplates(containers).map((c) => c.name), ["eve-sbx-tpl-abc"]);
});

test("doctor: an orphan fails with the exact remedy, a build warns, no containers says nothing (AC2, AC4)", () => {
  const orphan = templateContainerDoctorChecks(parseTemplateContainers("eve-sbx-tpl-def 0"));
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].verdict, "fail");
  assert.match(orphan[0].label, /orphaned sandbox template container eve-sbx-tpl-def/);
  assert.match(orphan[0].label, /every eve start will hang/);
  assert.ok(orphan[0].detail.includes(removeOrphanCommand("eve-sbx-tpl-def")));
  assert.equal(removeOrphanCommand("eve-sbx-tpl-def"), "docker rm -f eve-sbx-tpl-def");

  const building = templateContainerDoctorChecks(parseTemplateContainers("eve-sbx-tpl-abc 2"));
  assert.equal(building.length, 1);
  assert.equal(building[0].verdict, "warn");
  assert.match(building[0].detail, /do not restart/);

  // No Docker, or Docker with no template containers: nothing to say.
  assert.deepEqual(templateContainerDoctorChecks(parseTemplateContainers("")), []);
});

test("deploy wait: a silent log is progress while a template is building, for longer than the quiet limit (AC1)", () => {
  const quietLimitMs = 4 * 60_000;
  const sixMinutesSilent = { log: "using scripts/eve-server.sh\nbuilt\n", quietMs: 6 * 60_000, quietLimitMs };
  const building = assessRestart({ ...sixMinutesSilent, templates: parseTemplateContainers("eve-sbx-tpl-abc 4") });
  assert.equal(building.state, "building");
  assert.equal(building.detail, "eve-sbx-tpl-abc");

  // The same silence with nothing building is the old verdict: give up on the wait.
  const quiet = assessRestart({ ...sixMinutesSilent, templates: [] });
  assert.equal(quiet.state, "quiet");

  // And under the limit it is simply waiting.
  assert.equal(assessRestart({ ...sixMinutesSilent, quietMs: 30_000, templates: [] }).state, "waiting");
});

test("deploy wait: an orphan with nothing building is a stuck host with a remedy, not a slow one", () => {
  const verdict = assessRestart({
    log: "using scripts/eve-server.sh\n",
    templates: parseTemplateContainers("eve-sbx-tpl-def 0"),
    quietMs: 10_000,
    quietLimitMs: 4 * 60_000,
  });
  assert.equal(verdict.state, "orphaned");
  assert.match(verdict.detail, /eve-sbx-tpl-def \(remove it: docker rm -f eve-sbx-tpl-def\)/);
});

test("deploy wait: the log's own verdicts still win", () => {
  const templates = parseTemplateContainers("eve-sbx-tpl-abc 4");
  assert.equal(assessRestart({ log: "pid=12\nhealth: 200\n", templates, quietMs: 0, quietLimitMs: 1 }).state, "healthy");
  assert.equal(assessRestart({ log: "FAILED: the build did not succeed\n", templates, quietMs: 0, quietLimitMs: 1 }).state, "failed");
});
