import type { SandboxSession } from "eve/sandbox";
import { CHROME_DEBUG_PORT } from "./provider.js";

/**
 * Type values into a page open in the computer's Chrome, without the values
 * ever appearing in a tool result, a screenshot caption, or the model's
 * context. The caller (a vault or a wallet tool) resolves the secret server
 * side and hands it straight here; the model only ever names the fields.
 *
 * Transport is Chrome's own DevTools protocol on the container's loopback
 * (`--remote-debugging-port`): a small Node script runs INSIDE the computer,
 * receives the values on stdin (never argv or env, which `ps` would show),
 * finds the page by origin, and sets each field through the element's native
 * value setter plus the input/change events frameworks listen for. It reports
 * which selectors it filled and which it could not find — never what it typed.
 */
export interface FillField {
  /** CSS selector of the input, select or textarea. */
  readonly selector: string;
  /** What to type. Never logged, never returned. */
  readonly value: string;
  /** For a field inside an iframe (card forms often are): that frame's URL prefix. */
  readonly frameUrl?: string;
}

export interface FillRequest {
  /** The page to fill, matched by origin against Chrome's open tabs; the active tab when omitted. */
  readonly pageOrigin?: string;
  readonly fields: readonly FillField[];
  /** Press Enter in the last filled field (most login forms submit on it). */
  readonly submit?: boolean;
}

export interface FillResult {
  readonly ok: boolean;
  readonly filled: readonly string[];
  readonly missing: readonly string[];
  readonly page: string;
  readonly error?: string;
}

/** Fill a form in the computer's Chrome. Resolves even when fields are missing; throws only when Chrome or the page cannot be reached. */
export async function fillOnComputer(sandbox: SandboxSession, request: FillRequest): Promise<FillResult> {
  const result = await sandbox.run({
    command: `node --input-type=module -e ${shellQuote(FILL_SCRIPT)}`,
    // The values travel on stdin and nowhere else.
    stdin: JSON.stringify({ port: CHROME_DEBUG_PORT, ...request }),
  } as Parameters<SandboxSession["run"]>[0]);
  const out = (result.stdout ?? "").toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`could not fill the page: ${(result.stderr || out || "no output").toString().trim().slice(0, 400)}`);
  }
  let parsed: FillResult;
  try {
    parsed = JSON.parse(out.split("\n").pop() ?? "") as FillResult;
  } catch {
    throw new Error(`fill script returned no result: ${out.slice(0, 200)}`);
  }
  return parsed;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The in-computer script. Plain Node 24 (global WebSocket), no dependencies.
 * Exported so the unit tests can check it never echoes values.
 */
export const FILL_SCRIPT = String.raw`
const input = JSON.parse(await new Promise((resolve, reject) => {
  let data = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (data += c)); process.stdin.on("end", () => resolve(data)); process.stdin.on("error", reject);
}));
const base = "http://127.0.0.1:" + input.port;
const targets = await (await fetch(base + "/json/list")).json();
const pages = targets.filter((t) => t.type === "page");
const want = input.pageOrigin ? new URL(input.pageOrigin).origin : null;
const page = want ? pages.find((t) => { try { return new URL(t.url).origin === want; } catch { return false; } }) : pages[0];
if (!page) { console.log(JSON.stringify({ ok: false, filled: [], missing: input.fields.map((f) => f.selector), page: "", error: want ? "no open tab at " + want : "no open tab" })); process.exit(0); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("devtools socket failed")); });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const fillFn = String((selector, value, submit) => {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) { const form = el.form; if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); } }
  return true;
});
async function fillIn(sessionId, selector, value, submit) {
  const r = await send("Runtime.evaluate", { expression: "(" + fillFn + ")(" + JSON.stringify(selector) + "," + JSON.stringify(value) + "," + (submit ? "true" : "false") + ")", returnByValue: true, awaitPromise: true }, sessionId);
  return r && r.result && r.result.value === true;
}
// Frames: attach to child targets whose URL starts with frameUrl (card iframes).
const filled = [], missing = [];
const frameSessions = new Map();
async function sessionFor(frameUrl) {
  if (!frameUrl) return undefined;
  if (frameSessions.has(frameUrl)) return frameSessions.get(frameUrl);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { targetInfos } = await send("Target.getTargets");
  const frame = targetInfos.find((t) => t.type === "iframe" && t.url.startsWith(frameUrl));
  if (!frame) return null;
  const { sessionId } = await send("Target.attachToTarget", { targetId: frame.targetId, flatten: true });
  frameSessions.set(frameUrl, sessionId);
  return sessionId;
}
for (let i = 0; i < input.fields.length; i++) {
  const f = input.fields[i];
  const last = i === input.fields.length - 1;
  try {
    const sessionId = await sessionFor(f.frameUrl);
    if (sessionId === null) { missing.push(f.selector); continue; }
    (await fillIn(sessionId, f.selector, f.value, Boolean(input.submit && last)) ? filled : missing).push(f.selector);
  } catch { missing.push(f.selector); }
}
ws.close();
console.log(JSON.stringify({ ok: missing.length === 0, filled, missing, page: new URL(page.url).origin }));
`;
