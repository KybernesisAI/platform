import assert from "node:assert/strict";
import { test } from "node:test";
import { decideBrowserUse, serviceForUrl } from "../dist/policy.js";

test("a connector-covered host is recognised, including subdomains", () => {
  assert.equal(serviceForUrl("https://mail.google.com/mail/u/0/#inbox"), "gmail");
  assert.equal(serviceForUrl("https://acme.notion.site/roadmap"), "notion");
  assert.equal(serviceForUrl("https://linear.app/kyb/issue/KYB-1"), "linear");
  assert.equal(serviceForUrl("https://example.com"), null);
  assert.equal(serviceForUrl("not a url"), null);
});

test("the browser is allowed for sites with no connector", () => {
  assert.deepEqual(decideBrowserUse({ url: "https://news.ycombinator.com" }), { kind: "allowed" });
});

test("a connector-covered site parks without an override, and names the connector", () => {
  const d = decideBrowserUse({ url: "https://mail.google.com" });
  assert.equal(d.kind, "ask");
  assert.equal(d.service, "gmail");
  assert.match(d.reason, /gmail connector/);
});

test("an override lets the browser reach a connector-covered site", () => {
  for (const override of ["person-asked-for-browser", "must-act-as-the-person", "person-must-see-the-page"]) {
    assert.deepEqual(decideBrowserUse({ url: "https://linear.app/x", override }), { kind: "allowed" });
  }
});

test("the host list is the deployment's to extend", () => {
  const hosts = { acme: ["portal.acme.example"] };
  assert.equal(decideBrowserUse({ url: "https://portal.acme.example/x", hosts }).kind, "ask");
  assert.equal(decideBrowserUse({ url: "https://mail.google.com", hosts }).kind, "allowed");
});
