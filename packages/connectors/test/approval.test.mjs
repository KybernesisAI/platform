import assert from "node:assert/strict";
import { test } from "node:test";
import { asksFirst, connectAnswer, personApproves } from "../dist/index.js";

test("sending and calendar changes ask first; drafts, reads and searches do not", () => {
  for (const name of [
    "gmail_send_email",
    "gmail_send_email_work",
    "gmail_reply_to_thread",
    "gmail_forward_message",
    "gmail_send_draft",
    "outlook_send_email",
    "slack_sends_a_message_to_a_slack_channel",
    "slack_chat_post_message",
    "googlecalendar_create_event",
    "googlecalendar_update_event",
    "googlecalendar_delete_event",
    "googlecalendar_quick_add",
    "outlook_calendar_create_event",
    "connectors__gmail_send_email",
  ]) assert.equal(asksFirst(name), true, name);
  for (const name of [
    "gmail_create_email_draft",
    "gmail_fetch_emails",
    "gmail_list_threads",
    "googlecalendar_find_event",
    "googlecalendar_events_list",
    "googlecalendar_find_free_slots",
    "hubspot_create_contact",
    "github_create_a_pull_request",
    "notion_create_page",
  ]) assert.equal(asksFirst(name), false, name);
});

test("a person is asked; a routine with nobody to ask runs", () => {
  const person = { session: { auth: { current: { principalType: "user" } } } };
  const routine = { session: { auth: { current: { principalType: "runtime" } } } };
  assert.equal(personApproves({ toolName: "gmail_send_email", ...person }), "user-approval");
  assert.equal(personApproves({ toolName: "gmail_send_email", ...routine }), "not-applicable");
  assert.equal(personApproves({ toolName: "gmail_fetch_emails", ...person }), "not-applicable");
});

test("a routine that runs as its person still runs unasked", () => {
  const asPerson = { session: { auth: { current: { principalType: "user", attributes: { trigger: "routine", routine: "digest" } } } } };
  assert.equal(personApproves({ toolName: "gmail_send_email", ...asPerson }), "not-applicable");
  assert.equal(personApproves({ toolName: "googlecalendar_create_event", ...asPerson }), "not-applicable");
});

test("connecting gives a sign-in card, or words when it cannot", () => {
  const link = connectAnswer({ ok: true, service: "HubSpot", slug: "hubspot", connected: false, url: "https://connect.example/s/abc" });
  assert.equal(link.kyb.card, "link");
  assert.equal(link.kyb.data.title, "Connect HubSpot");
  assert.deepEqual(link.kyb.actions[0], { label: "Connect HubSpot", url: "https://connect.example/s/abc", primary: true });
  assert.deepEqual(link.kyb.actions[1], { label: "Cancel", say: "Never mind, don't connect HubSpot." });
  assert.match(link.kyb.text, /https:\/\/connect\.example\/s\/abc/);
  assert.match(link.kyb.data.description, /your own HubSpot account/);
  const company = connectAnswer({ ok: true, service: "Slack", slug: "slack", connected: false, url: "https://connect.example/s/def", shared: true, note: "Slack may ask a workspace admin on their side to approve it." });
  assert.match(company.kyb.data.description, /for the whole company.*workspace admin/);
  assert.match(company.message, /workspace admin/);
  const already = connectAnswer({ ok: true, service: "Gmail", connected: true });
  assert.equal(already.connected, true);
  assert.equal("kyb" in already, false);
  const missing = connectAnswer({ ok: false, reason: "not_on_shelf", message: "Zernio is not one of the services this company has approved.", available: ["Gmail", "HubSpot"] });
  assert.deepEqual(missing.available, ["Gmail", "HubSpot"]);
  assert.match(missing.message, /Zernio/);
  const shelf = connectAnswer({ ok: true, shelf: [{ name: "Gmail", slug: "gmail", connected: true, fromChat: true }] });
  assert.deepEqual(shelf.services, [{ name: "Gmail", connected: true, connectFromChat: true }]);
});
