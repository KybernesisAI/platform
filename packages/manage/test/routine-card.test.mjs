import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { routineTools } from "../dist/index.js";

test("a new routine comes back with a card: the schedule in words, the next run, run now and change", async () => {
  // The background rebuild is not under test; a shell that does nothing stands in.
  process.env.SHELL = "/bin/true";
  const appRoot = mkdtempSync(join(tmpdir(), "routine-"));
  writeFileSync(join(appRoot, "package.json"), "{}");
  const tools = routineTools({ appRoot });
  const out = await tools.create_routine.execute({ name: "Morning brief", cron: "40 8 * * 1-5", instruction: "Send the brief." });
  assert.equal(out.created, true);
  assert.equal(out.kyb.card, "routine");
  assert.equal(out.kyb.id, "routine-morning-brief");
  assert.equal(out.kyb.data.name, "Morning brief");
  assert.equal(out.kyb.data.schedule, "Weekdays at 8:40 AM");
  const next = new Date(out.kyb.data.nextRun);
  assert.deepEqual([next.getHours(), next.getMinutes()], [8, 40]);
  assert.ok([1, 2, 3, 4, 5].includes(next.getDay()));
  assert.deepEqual(out.kyb.actions.map((a) => a.label), ["Run it now", "Change it"]);
  // The cron and the host's offset ride along, so an app can say it in the reader's zone.
  assert.equal(out.kyb.data.cron, "40 8 * * 1-5");
  assert.equal(out.kyb.data.offset, -next.getTimezoneOffset());
  const model = tools.create_routine.toModelOutput(out);
  assert.equal("kyb" in model.value, false);
  assert.match(model.value.shownToPerson, /routine/);
});

test("a routine whose first time comes before it goes live says so, and counts its first run from then", async () => {
  process.env.SHELL = "/bin/true";
  const appRoot = mkdtempSync(join(tmpdir(), "routine-"));
  writeFileSync(join(appRoot, "package.json"), "{}");
  const tools = routineTools({ appRoot, restartCommand: "true" });
  const soon = new Date(Date.now() + 60_000);
  const cron = `${soon.getMinutes()} ${soon.getHours()} * * *`;
  const out = await tools.create_routine.execute({ name: "Soon", cron, instruction: "Say hi." });
  assert.match(out.note, /will not run then/);
  const first = new Date(out.firstRun);
  assert.ok(first.getTime() - Date.now() > 23 * 3_600_000, "the first run is tomorrow's");
  assert.equal(out.kyb.data.nextRun, out.firstRun);

  const later = new Date(Date.now() + 10 * 60_000);
  const ok = await tools.create_routine.execute({ name: "Later", cron: `${later.getMinutes()} ${later.getHours()} * * *`, instruction: "Say hi." });
  assert.match(ok.note, /goes live in about two minutes/);
  assert.doesNotMatch(ok.note, /will not run then/);
});
