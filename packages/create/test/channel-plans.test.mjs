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
  assert.ok(plan.deps.includes("@kybernesis/multiplayer@eve-0.81"));
});

test("exe imessage: the identity-gated Linq channel the Channels page connects, not Photon", () => {
  const plan = channelPlan("imessage", "planner", "exe");
  assert.equal(plan.file, "linq.ts");
  assert.match(plan.content, /linqSenderIdentity/);
  assert.doesNotMatch(plan.content, /photon/i);
  assert.deepEqual(plan.env, [], "LINQ keys are written by linq.verify, never by hand");
});

test("exe imessage: a long job's on-it note is posted in the text thread", () => {
  const plan = channelPlan("imessage", "planner", "exe");
  assert.match(plan.content, /events: progressEvents\(\)/);
  assert.match(plan.content, /`working_on_it`/);
  assert.ok(plan.deps.includes("@kybernesis/cards"));
});

test("vercel channels are unchanged", () => {
  assert.match(channelPlan("slack", "planner", "vercel").content, /connectSlackCredentials/);
  assert.equal(channelPlan("imessage", "planner", "vercel").file, "photon.ts");
});
