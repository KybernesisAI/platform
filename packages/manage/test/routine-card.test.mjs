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
