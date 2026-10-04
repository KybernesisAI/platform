import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { TicketStore, probeComputer, ticketFromUrl } from "../dist/computer.js";

test("a ticket works exactly once, and not after it expires", () => {
  let now = 1_000;
  const store = new TicketStore(() => now, 60_000);
  const { ticket } = store.issue();
  assert.equal(store.consume("nope"), false);
  assert.equal(store.consume(ticket), true);
  assert.equal(store.consume(ticket), false, "second use is refused");
  const late = store.issue().ticket;
  now += 60_001;
  assert.equal(store.consume(late), false, "expired");
});

test("the ticket is read from the relay URL's query", () => {
  assert.equal(ticketFromUrl("/eve/v1/kyb/computer/ws?ticket=abc"), "abc");
  assert.equal(ticketFromUrl("http://h/eve/v1/kyb/computer/ws"), null);
});

test("probe: a listening loopback port is present, a closed one is not", async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  assert.equal(await probeComputer(port), true);
  server.close();
  await new Promise((r) => server.once("close", r));
  assert.equal(await probeComputer(port), false);
});
