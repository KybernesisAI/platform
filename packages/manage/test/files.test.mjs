import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliveryHeaders, fileRoutes, resolveDelivery } from "../dist/files.js";

const ID = "0123456789abcdef0123456789abcdef";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-files-"));
  mkdirSync(join(dir, ID));
  writeFileSync(join(dir, ID, "report.md"), "# Report");
  writeFileSync(join(dir, ID, "site page.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "secret.txt"), "not delivered");
  return dir;
}

test("a delivered file resolves by its id and name", () => {
  const dir = store();
  assert.deepEqual(resolveDelivery(dir, ID, "report.md"), { path: join(dir, ID, "report.md"), contentType: "text/plain; charset=utf-8" });
  assert.equal(resolveDelivery(dir, ID, "site%20page.html").contentType, "text/html; charset=utf-8");
});

test("nothing outside a delivery resolves", () => {
  const dir = store();
  for (const [id, name] of [
    [ID, "missing.md"],
    ["0123", "report.md"],
    [ID.toUpperCase(), "report.md"],
    [ID, ".."],
    [ID, "..%2Fsecret.txt"],
    [ID, "%2E%2E%2Fsecret.txt"],
    [ID, "a%2Fb"],
    [ID, "%E0%A4%A"],
    ["..", "secret.txt"],
  ]) {
    assert.equal(resolveDelivery(dir, id, name), null, `${id}/${name}`);
  }
});

test("pages render sandboxed and the link does not leak", () => {
  const html = deliveryHeaders("text/html; charset=utf-8", "page.html");
  assert.match(html["content-security-policy"], /^sandbox/);
  assert.equal(html["referrer-policy"], "no-referrer");
  assert.equal(html["x-content-type-options"], "nosniff");
  assert.match(html["content-disposition"], /^inline/);
  assert.match(deliveryHeaders("application/zip", "a.zip")["content-disposition"], /^attachment/);
});

test("the routes serve a delivery and 404 everything else, with no auth", async () => {
  const dir = store();
  const routes = fileRoutes({ prefix: "/eve/v1/kyb", options: { dir } });
  const probe = routes.find((r) => r.path === "/eve/v1/kyb/files");
  assert.equal((await probe.handler(new Request("http://x/eve/v1/kyb/files"), { params: {} })).status, 200);
  const serve = routes.find((r) => r.path === "/eve/v1/kyb/files/:id/:name");
  const ok = await serve.handler(new Request("http://x/"), { params: { id: ID, name: "report.md" } });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "# Report");
  const no = await serve.handler(new Request("http://x/"), { params: { id: ID, name: "..%2Fsecret.txt" } });
  assert.equal(no.status, 404);
});
