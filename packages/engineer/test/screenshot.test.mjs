import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import screenshot from "../dist/extension/tools/screenshot.mjs";

/** A PNG header claiming the given size: enough for the dimension check. */
function pngHeader(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("a capture taller than a many-image request allows is refused, not handed to the model", async () => {
  const ctx = {
    getSandbox: async () => ({
      run: async () => ({ stdout: "", stderr: "" }),
      writeTextFile: async () => {},
      readBinaryFile: async () => pngHeader(390, 11923),
    }),
  };
  await assert.rejects(screenshot.execute({ html: "<p>x</p>", width: 390, height: 844, fullPage: true, offsetY: 0 }, ctx), /390x11923 px, over the 2000 px limit/);
});

// The real runner against a real browser, when this machine has Playwright.
const hasPlaywright = (() => {
  try {
    createRequire(join(process.cwd(), "x.js"))("playwright");
    return true;
  } catch {
    return false;
  }
})();

/** A sandbox whose /workspace is a temp folder on this machine. */
function localSandbox() {
  const root = mkdtempSync(join(tmpdir(), "kyb-shot-"));
  const map = (p) => (p.startsWith("/workspace") ? root + p.slice("/workspace".length) : join(root, p));
  return {
    run: async ({ command }) => {
      try {
        const stdout = execSync(command.replaceAll("/workspace", root), { encoding: "utf8", env: { ...process.env, NODE_PATH: process.env.NODE_PATH ?? "" } });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (error) {
        return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error), exitCode: 1 };
      }
    },
    writeTextFile: async ({ path, content }) => {
      mkdirSync(dirname(map(path)), { recursive: true });
      writeFileSync(map(path), content.replaceAll("/workspace", root));
    },
    readBinaryFile: async ({ path }) => {
      try {
        return new Uint8Array(readFileSync(map(path)));
      } catch {
        return null;
      }
    },
  };
}

const TALL = `<!doctype html><body style="margin:0"><div style="height:11923px;background:linear-gradient(#000,#fff)"></div></body>`;

test("a long phone page comes back one slice at a time, each under the limit", { skip: !hasPlaywright && "no Playwright here" }, async () => {
  const sandbox = localSandbox();
  const ctx = { getSandbox: async () => sandbox };
  const first = await screenshot.execute({ html: TALL, width: 390, height: 844, fullPage: true, offsetY: 0 }, ctx);
  assert.deepEqual([first.width, first.height], [390, 2000]);
  assert.deepEqual(first.shown, { from: 0, to: 2000, pageHeight: 11923 });
  assert.equal(first.nextOffsetY, 2000);

  const last = await screenshot.execute({ html: TALL, width: 390, height: 844, fullPage: true, offsetY: 11000 }, ctx);
  assert.deepEqual([last.width, last.height], [390, 923]);
  assert.equal(last.nextOffsetY, undefined);
  const text = screenshot.toModelOutput(last).value[0].text;
  assert.match(text, /from 11000 to 11923 px of 11923 px\. That is the bottom of the page\./);

  const screen = await screenshot.execute({ html: TALL, width: 390, height: 844, fullPage: false, offsetY: 0 }, ctx);
  assert.deepEqual([screen.width, screen.height], [390, 844]);
  assert.equal(screen.shown, undefined);
});
