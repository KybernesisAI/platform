import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CALLBACK_BASE_HEADER,
  correctCallbackUrl,
  isLoopbackHost,
  ownCallbackBase,
  withCallbackBase,
} from "../dist/callback-base.js";

const LOOPBACK_CALLBACK = "http://localhost:3000/eve/v1/callback/tok%2F1?x=1";

test("loopback hosts are recognised and public ones are not", () => {
  for (const host of ["localhost", "LOCALHOST.", "app.localhost", "127.0.0.1", "127.9.8.7", "[::1]", "::1", "0.0.0.0"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["planner.exe.xyz", "128.0.0.1", "localhost.example.com", "10.0.0.2"]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test("own callback base: EVE_PUBLIC_URL, then the exe VM name, never on Vercel", () => {
  assert.equal(ownCallbackBase({ EVE_PUBLIC_URL: "https://planner.example.com/some/path" }), "https://planner.example.com");
  assert.equal(ownCallbackBase({ EXE_VM_NAME: "planner" }), "https://planner.exe.xyz");
  assert.equal(ownCallbackBase({ EVE_PUBLIC_URL: " ", EXE_VM_NAME: "planner" }), "https://planner.exe.xyz");
  assert.equal(ownCallbackBase({ VERCEL: "1", EXE_VM_NAME: "planner" }), undefined);
  assert.equal(ownCallbackBase({ EVE_PUBLIC_URL: "ftp://planner.example.com" }), undefined);
  assert.equal(ownCallbackBase({}), undefined);
});

test("only a loopback callback is corrected, keeping its path and query", () => {
  assert.equal(
    correctCallbackUrl(LOOPBACK_CALLBACK, "https://planner.exe.xyz"),
    "https://planner.exe.xyz/eve/v1/callback/tok%2F1?x=1",
  );
  const publicCallback = "https://planner.exe.xyz/eve/v1/callback/tok";
  assert.equal(correctCallbackUrl(publicCallback, "https://elsewhere.example.com"), publicCallback);
  assert.equal(correctCallbackUrl(LOOPBACK_CALLBACK, undefined), LOOPBACK_CALLBACK);
  assert.equal(correctCallbackUrl(LOOPBACK_CALLBACK, "not a url"), LOOPBACK_CALLBACK);
  assert.equal(correctCallbackUrl(LOOPBACK_CALLBACK, "javascript:alert(1)"), LOOPBACK_CALLBACK);
});

function channel() {
  const seen = [];
  const handler = async (request) => {
    seen.push({ url: request.url, headers: request.headers, body: await request.text() });
    return new Response("ok");
  };
  return {
    seen,
    channel: {
      __kind: "channel",
      routes: [
        { transport: "http", method: "POST", path: "/eve/v1/session", handler },
        { transport: "http", method: "POST", path: "/eve/v1/session/:sessionId", handler },
        { transport: "http", method: "POST", path: "/eve/v1/session/:sessionId/cancel", handler },
        { transport: "http", method: "GET", path: "/eve/v1/health", handler },
      ],
    },
  };
}

function post(path, body, headers = {}) {
  return new Request(`http://127.0.0.1:8000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("session create and continue get the caller's address; other routes are untouched", async () => {
  const { seen, channel: raw } = channel();
  const wrapped = withCallbackBase(raw);
  assert.equal(wrapped.__kind, "channel");
  assert.equal(wrapped.routes[2].handler, raw.routes[2].handler);
  assert.equal(wrapped.routes[3].handler, raw.routes[3].handler);

  const body = { message: "hi", callback: { callId: "c1", token: "t", url: LOOPBACK_CALLBACK } };
  const auth = { authorization: "Bearer x", [CALLBACK_BASE_HEADER]: "https://planner.exe.xyz" };
  await wrapped.routes[0].handler(post("/eve/v1/session", body, auth));
  await wrapped.routes[1].handler(post("/eve/v1/session/s1", body, auth));

  for (const call of seen) {
    const sent = JSON.parse(call.body);
    assert.equal(sent.callback.url, "https://planner.exe.xyz/eve/v1/callback/tok%2F1?x=1");
    assert.equal(sent.callback.callId, "c1");
    assert.equal(sent.message, "hi");
    assert.equal(call.headers.get("authorization"), "Bearer x");
  }
  assert.match(seen[1].url, /\/eve\/v1\/session\/s1$/);
});

test("without the header, a public callback, or a non-JSON body, the request passes through as sent", async () => {
  const { seen, channel: raw } = channel();
  const wrapped = withCallbackBase(raw);
  const header = { [CALLBACK_BASE_HEADER]: "https://planner.exe.xyz" };

  const loopback = { callback: { url: LOOPBACK_CALLBACK } };
  const publicOne = { callback: { url: "https://caller.example.com/eve/v1/callback/t" } };
  await wrapped.routes[0].handler(post("/eve/v1/session", loopback));
  await wrapped.routes[0].handler(post("/eve/v1/session", publicOne, header));
  await wrapped.routes[0].handler(post("/eve/v1/session", "not json", header));
  await wrapped.routes[0].handler(post("/eve/v1/session", { message: "no callback" }, header));

  assert.deepEqual(JSON.parse(seen[0].body), loopback);
  assert.deepEqual(JSON.parse(seen[1].body), publicOne);
  assert.equal(seen[2].body, "not json");
  assert.deepEqual(JSON.parse(seen[3].body), { message: "no callback" });
});
