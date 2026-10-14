import { test } from "node:test";
import assert from "node:assert/strict";
import { channelPlan } from "../dist/templates.js";

test("exe slack: the agent's own Slack app from the control plane, identity on, nothing on the host", () => {
  const plan = channelPlan("slack", "planner", "exe");
  assert.equal(plan.file, "slack.ts");
  assert.match(plan.content, /controlPlaneSlackCredentials\(\{ issuer, credential \}\)/);
  assert.match(plan.content, /identity: credential \? channelIdentity/);
  assert.doesNotMatch(plan.content, /SLACK_BOT_TOKEN|SLACK_SOCKET/);
  assert.deepEqual(plan.env, []);
  assert.ok(plan.deps.some((d) => d.startsWith("@kybernesis/multiplayer@^0.6")));
});

test("exe imessage: the identity-gated Linq channel the Channels page connects, not Photon", () => {
  const plan = channelPlan("imessage", "planner", "exe");
  assert.equal(plan.file, "linq.ts");
  assert.match(plan.content, /linqSenderIdentity/);
  assert.doesNotMatch(plan.content, /photon/i);
  assert.deepEqual(plan.env, [], "LINQ keys are written by linq.verify, never by hand");
});

test("vercel channels are unchanged", () => {
  assert.match(channelPlan("slack", "planner", "vercel").content, /connectSlackCredentials/);
  assert.equal(channelPlan("imessage", "planner", "vercel").file, "photon.ts");
});
