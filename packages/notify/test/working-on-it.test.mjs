import assert from "node:assert/strict";
import { test } from "node:test";

import { progressNotes } from "@kybernesis/cards";
import tool from "../dist/extension/tools/working_on_it.mjs";

test("the note comes back in the result, on one line, where the surfaces read it", async () => {
  const output = await tool.execute({ message: "On it.\n  Building your daily calendar page now." });
  assert.deepEqual(output, { sent: true, message: "On it. Building your daily calendar page now." });
  const notes = progressNotes("action.result", {
    turnId: "t1",
    status: "completed",
    result: { callId: "c1", toolName: "notify__working_on_it", output },
  });
  assert.deepEqual(notes.map((n) => n.text), ["On it. Building your daily calendar page now."]);
});

test("the live step in Studio and the phone is the message itself", () => {
  assert.equal(tool.label.start({ message: "On it." }), "On it.");
});

test("the model is told the note went and that its reply is the result", () => {
  const seen = tool.toModelOutput({ sent: true, message: "On it." });
  assert.equal(seen.type, "text");
  assert.match(seen.value, /without repeating/);
});

test("the description teaches when not to send one", () => {
  assert.match(tool.description, /more than a minute/);
  assert.match(tool.description, /Always use it before you make or change an artifact/);
  assert.match(tool.description, /Do not use it for a question you can answer straight away/);
  assert.doesNotMatch(tool.description, /—/, "agent-facing text carries no em dashes");
});
