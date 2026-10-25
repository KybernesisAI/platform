import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bridgeUnit, buzzFollowsOwner, parseProfileOutput, parseRelays } from "../dist/buzz.js";
import { parseEnv } from "../dist/setup-env.js";
import { createSetupActions, setupStatus } from "../dist/setup.js";

const NPUB = `npub1${"q".repeat(58)}`;
const HEX = "ab".repeat(32);

function agentDir(deps = { "@kybernesis/buzz": "^0.10.2" }) {
  const dir = mkdtempSync(join(tmpdir(), "kyb-buzz-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
  return dir;
}

/** A host where the bridge unit and the Buzz CLI are both fakes that remember what was asked of them. */
function fakeHost({ member = () => true, unit = "missing" } = {}) {
  const calls = [];
  const state = { unit, active: false };
  const exec = async (file, args, opts) => {
    calls.push({ argv: [file, ...args], env: opts.env ?? {} });
    const cmd = [file, ...args].join(" ");
    if (cmd === "npx kybernesis-buzz init") {
      writeFileSync(opts.env.BUZZ_KEYFILE, '{"secretKey":[1]}');
      return { code: 0, stdout: `  Invite this to the workspace:\n\n    ${NPUB}\n\n  hex: ${HEX}\n`, stderr: "" };
    }
    if (cmd.startsWith("npx kybernesis-buzz profile")) {
      const lines = opts.env.BUZZ_RELAY.split(",").map((r) =>
        member(r) ? `  ✓ ${r}` : `  · ${r} — not a member yet, so nothing to be known as there`,
      );
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    }
    if (cmd.startsWith("systemctl show")) return { code: 0, stdout: state.unit === "missing" ? "not-found\n" : "loaded\n", stderr: "" };
    if (cmd.startsWith("systemctl is-active")) return { code: 3, stdout: state.active ? "active\n" : "inactive\n", stderr: "" };
    if (cmd.startsWith("sudo -n install")) {
      state.unit = "loaded";
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd.startsWith("sudo -n systemctl restart")) state.active = true;
    if (cmd.startsWith("sudo -n systemctl disable --now")) state.active = false;
    if (cmd.startsWith("sudo -n")) return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${cmd}` };
  };
  return { exec, calls, state };
}

const restarter = () => {
  const r = { requested: 0 };
  r.request = () => {
    r.requested += 1;
    return { restart: "scheduled", inFlight: 0, note: "" };
  };
  r.state = () => ({ restart: "idle", inFlight: 0, note: "" });
  r.pending = false;
  return r;
};

test("relays: an https community address becomes its wss relay; anything else is refused", () => {
  assert.deepEqual(parseRelays("https://team.communities.buzz.xyz/"), { ok: true, relays: ["wss://team.communities.buzz.xyz"] });
  assert.deepEqual(parseRelays(["wss://a.example", "wss://a.example", "wss://b.example"]).relays, ["wss://a.example", "wss://b.example"]);
  assert.equal(parseRelays("http://a.example").ok, false);
  assert.equal(parseRelays("wss://user:pw@a.example").ok, false);
  assert.equal(parseRelays("wss://a.example?x=1").ok, false);
  assert.equal(parseRelays("").ok, false);
  assert.equal(parseRelays("wss://1 wss://2 wss://3 wss://4 wss://5 wss://6").ok, false);
});

test("profile output: member, not yet a member, and refused are told apart per relay", () => {
  const out = "  ✓ wss://a\n  · wss://b — not a member yet, so nothing\n  ✕ wss://c — connection refused\n";
  const [a, b, c, d] = parseProfileOutput(out, ["wss://a", "wss://b", "wss://c", "wss://d"]);
  assert.deepEqual(a, { url: "wss://a", member: true });
  assert.equal(b.member, false);
  assert.match(b.detail, /admin adds/);
  assert.equal(c.detail, "connection refused");
  assert.equal(d.member, false);
});

test("bridge unit: reads the agent's env file and starts after the agent", () => {
  const unit = bridgeUnit({ agent: "planner", user: "exedev", appDir: "/home/exedev/planner" });
  assert.match(unit, /After=network-online.target planner-agent.service/);
  assert.match(unit, /\. \.\/\.env\.local/);
  assert.match(unit, /exec npx kybernesis-buzz run/);
  assert.match(unit, /User=exedev/);
});

test("buzz.join: writes the relay and key, publishes the profile, installs and starts the bridge", async () => {
  const dir = agentDir();
  const host = fakeHost({ member: (r) => r.includes("team") });
  const r = restarter();
  const actions = createSetupActions({ appRoot: dir, agent: "planner", options: { exec: host.exec }, restarter: r });
  assert.ok(actions.names.includes("buzz.join") && actions.names.includes("buzz.leave"));

  assert.equal((await actions.run({ action: "buzz.join", relay: "ftp://x" })).status, 400);
  assert.equal((await actions.run({ action: "buzz.join", relay: "wss://team.example", picture: "http://x/p.png" })).status, 400);

  const joined = await actions.run({
    action: "buzz.join",
    relay: "https://team.example, wss://other.example",
    name: "Planner",
    picture: "https://cdn.example/p.png",
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.npub, NPUB);
  assert.equal(joined.body.bridge, "active");
  assert.deepEqual(
    joined.body.relays.map((o) => [o.url, o.member]),
    [
      ["wss://team.example", true],
      ["wss://other.example", false],
    ],
  );
  assert.match(joined.body.next, /other\.example/);
  assert.match(joined.body.next, new RegExp(NPUB));
  assert.equal(r.requested, 1, "the agent restarts to read the new relay");

  const env = parseEnv(readFileSync(join(dir, ".env.local"), "utf8"));
  assert.equal(env.get("BUZZ_RELAY"), "wss://team.example,wss://other.example");
  assert.equal(env.get("BUZZ_KEYFILE"), join(dir, ".buzz", "agent-key.json"));

  const profile = host.calls.find((c) => c.argv.includes("profile"));
  assert.deepEqual(profile.argv.slice(3), ["--name", "Planner", "--picture", "https://cdn.example/p.png"]);
  assert.ok(host.calls.some((c) => c.argv.join(" ").startsWith("sudo -n install -m 644")), "the unit is installed when missing");
  assert.ok(host.calls.some((c) => c.argv.join(" ") === "sudo -n systemctl enable planner-buzz-bridge"));

  // Joining again, unchanged: the profile is published again, nothing restarts.
  const restartsBefore = host.calls.filter((c) => c.argv.join(" ").startsWith("sudo -n systemctl restart")).length;
  const again = await actions.run({ action: "buzz.join", relay: "wss://team.example,wss://other.example" });
  assert.equal(again.status, 200);
  assert.equal(r.requested, 1, "no agent restart when nothing changed");
  assert.equal(host.calls.filter((c) => c.argv.join(" ").startsWith("sudo -n systemctl restart")).length, restartsBefore, "a running bridge is not bounced");
  assert.equal(host.calls.filter((c) => c.argv.join(" ") === "npx kybernesis-buzz init").length, 2, "the key is made and read once, then cached");

  const status = await setupStatus({ appRoot: dir, agent: "planner", options: { exec: host.exec }, restarter: r });
  const item = status.items.find((i) => i.id === "buzz");
  assert.equal(item.done, true);
  assert.match(item.detail, /Waiting for an admin.*other\.example/);
  assert.deepEqual(status.buzz, {
    npub: NPUB,
    hex: HEX,
    relays: ["wss://team.example", "wss://other.example"],
    members: ["wss://team.example"],
    bridge: "active",
  });

  const left = await actions.run({ action: "buzz.leave" });
  assert.equal(left.status, 200);
  assert.equal(left.body.bridge, "inactive");
  assert.ok(host.calls.some((c) => c.argv.join(" ") === "sudo -n systemctl disable --now planner-buzz-bridge"));
  assert.equal(parseEnv(readFileSync(join(dir, ".env.local"), "utf8")).get("BUZZ_RELAY"), undefined);
  assert.ok(parseEnv(readFileSync(join(dir, ".env.local"), "utf8")).get("BUZZ_KEYFILE"), "the key is kept");
});

test("buzz status: absent without the package; a fresh agent shows its key and is not done", async () => {
  const r = restarter();
  const none = await setupStatus({ appRoot: agentDir({}), agent: "planner", options: { exec: fakeHost().exec }, restarter: r });
  assert.equal(none.buzz, undefined);
  assert.equal(none.items.some((i) => i.id === "buzz"), false);

  const dir = agentDir();
  const keyFile = join(dir, "key.json");
  writeFileSync(keyFile, '{"secretKey":[1]}');
  writeFileSync(join(dir, ".env.local"), `BUZZ_KEYFILE=${keyFile}\n`);
  const host = fakeHost({ unit: "loaded" });
  const fresh = await setupStatus({ appRoot: dir, agent: "planner", options: { exec: host.exec }, restarter: r });
  assert.equal(fresh.buzz.npub, NPUB);
  assert.equal(fresh.buzz.bridge, "inactive");
  const item = fresh.items.find((i) => i.id === "buzz");
  assert.equal(item.done, false);
  assert.match(item.detail, /Ready for your Buzz community/);

  await setupStatus({ appRoot: dir, agent: "planner", options: { exec: host.exec }, restarter: r });
  assert.equal(host.calls.filter((c) => c.argv.includes("init")).length, 1, "the key is read once and cached");
});

test("buzz.join: refused when Buzz is not installed", async () => {
  const actions = createSetupActions({ appRoot: agentDir({}), agent: "planner", options: { exec: fakeHost().exec }, restarter: restarter() });
  assert.equal((await actions.run({ action: "buzz.join", relay: "wss://team.example" })).status, 409);
});

/** An agent whose installed @kybernesis/buzz is `version`. */
function withInstalledBuzz(dir, version) {
  mkdirSync(join(dir, "node_modules", "@kybernesis", "buzz"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "@kybernesis", "buzz", "package.json"), JSON.stringify({ name: "@kybernesis/buzz", version }));
}

test("buzz follows the owner from 0.11", () => {
  assert.equal(buzzFollowsOwner("0.10.2"), false);
  assert.equal(buzzFollowsOwner("0.11.0"), true);
  assert.equal(buzzFollowsOwner("1.0.0"), true);
  assert.equal(buzzFollowsOwner(null), false);
});

test("buzz.join on a Buzz that follows the owner publishes the owner's face, with the agent's credential", async () => {
  const dir = agentDir({ "@kybernesis/buzz": "^0.11.0" });
  withInstalledBuzz(dir, "0.11.0");
  writeFileSync(join(dir, ".env.local"), "KYBERNESIS_AGENT_CREDENTIAL=cred\nKYBERNESIS_ISSUER=https://cp.example\n");
  const host = fakeHost();
  const actions = createSetupActions({ appRoot: dir, agent: "planner", options: { exec: host.exec }, restarter: restarter() });
  assert.equal((await actions.run({ action: "buzz.join", relay: "wss://team.example" })).status, 200);
  const profile = host.calls.find((c) => c.argv.includes("profile"));
  assert.deepEqual(profile.argv.slice(3), ["--sync"]);
  assert.equal(profile.env.KYBERNESIS_AGENT_CREDENTIAL, "cred");
  assert.equal(profile.env.KYBERNESIS_ISSUER, "https://cp.example");
});

test("buzz.profile: sends the face to every community, advertised only on a Buzz that can", async () => {
  const dir = agentDir({ "@kybernesis/buzz": "^0.11.0" });
  const host = fakeHost({ member: (r) => r.includes("team"), unit: "loaded" });
  const r = restarter();
  const actions = createSetupActions({ appRoot: dir, agent: "planner", options: { exec: host.exec }, restarter: r });

  withInstalledBuzz(dir, "0.10.2");
  assert.equal((await actions.run({ action: "buzz.profile" })).status, 409, "an older Buzz cannot");
  const keyFile = join(dir, "key.json");
  writeFileSync(keyFile, '{"secretKey":[1]}');
  writeFileSync(join(dir, ".env.local"), `BUZZ_KEYFILE=${keyFile}\nKYBERNESIS_AGENT_CREDENTIAL=cred\n`);
  const old = await setupStatus({ appRoot: dir, agent: "planner", options: { exec: host.exec }, restarter: r });
  assert.deepEqual(old.items.find((i) => i.id === "buzz").actions, ["buzz.join", "buzz.leave"]);

  withInstalledBuzz(dir, "0.11.0");
  const notJoined = await actions.run({ action: "buzz.profile" });
  assert.equal(notJoined.status, 409);
  assert.match(notJoined.body.error, /Channels page/);

  writeFileSync(join(dir, ".env.local"), `BUZZ_KEYFILE=${keyFile}\nKYBERNESIS_AGENT_CREDENTIAL=cred\nBUZZ_RELAY=wss://team.example,wss://other.example\n`);
  const sent = await actions.run({ action: "buzz.profile", name: "ignored" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.sent, 1);
  assert.deepEqual(sent.body.relays.map((o) => [o.url, o.member]), [["wss://team.example", true], ["wss://other.example", false]]);
  const call = host.calls.find((c) => c.argv.includes("profile"));
  assert.deepEqual(call.argv.slice(3), ["--sync"], "the face comes from the control plane, never from the body");
  assert.equal(call.env.KYBERNESIS_AGENT_CREDENTIAL, "cred");
  assert.equal(r.requested, 0, "sending a profile never restarts the agent");

  const status = await setupStatus({ appRoot: dir, agent: "planner", options: { exec: host.exec }, restarter: r });
  assert.deepEqual(status.items.find((i) => i.id === "buzz").actions, ["buzz.join", "buzz.leave", "buzz.profile"]);
  assert.deepEqual(status.buzz.members, ["wss://team.example"]);
});

test("profile output: a picture that did not go is said, and the community still counts", () => {
  const [a] = parseProfileOutput("  ✓ wss://a — picture not sent: the community refused the image: 413\n", ["wss://a"]);
  assert.equal(a.member, true);
  assert.match(a.detail, /picture did not go.*413/);
});

test("buzz.join finds the bridge by the folder it runs in, never installs a second, and switches off an extra", async () => {
  const dir = agentDir();
  const calls = [];
  // The agent is called "Kyber"; its bridge was set up by hand as kyber-buzz-bridge, and a
  // second one (Kyber-buzz-bridge) was later installed beside it. Both run in its folder.
  const units = {
    "kyber-buzz-bridge": { dir, active: true },
    "Kyber-buzz-bridge": { dir, active: true },
    "other-buzz-bridge": { dir: "/home/someone/other", active: true },
  };
  const exec = async (file, args, opts) => {
    calls.push([file, ...args].join(" "));
    const cmd = [file, ...args].join(" ");
    if (cmd === "npx kybernesis-buzz init") {
      writeFileSync(opts.env.BUZZ_KEYFILE, '{"secretKey":[1]}');
      return { code: 0, stdout: `${NPUB}\n  hex: ${HEX}\n`, stderr: "" };
    }
    if (cmd.startsWith("npx kybernesis-buzz profile")) return { code: 0, stdout: "  ✓ wss://team.example", stderr: "" };
    if (cmd.startsWith("systemctl list-unit-files")) {
      return { code: 0, stdout: Object.keys(units).map((u) => `${u}.service enabled enabled`).join("\n"), stderr: "" };
    }
    const unit = args.at(-1);
    if (cmd.startsWith("systemctl show -p WorkingDirectory")) return { code: 0, stdout: `${units[unit]?.dir ?? ""}\n`, stderr: "" };
    if (cmd.startsWith("systemctl show")) return { code: 0, stdout: units[unit] ? "loaded\n" : "not-found\n", stderr: "" };
    if (cmd.startsWith("systemctl is-active")) return { code: 0, stdout: units[unit]?.active ? "active\n" : "inactive\n", stderr: "" };
    if (cmd.startsWith("sudo -n systemctl disable --now")) units[unit].active = false;
    if (cmd.startsWith("sudo -n")) return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${cmd}` };
  };
  const r = restarter();
  const actions = createSetupActions({ appRoot: dir, agent: "Kyber", options: { exec }, restarter: r });
  const joined = await actions.run({ action: "buzz.join", relay: "wss://team.example" });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.bridge, "active");
  assert.equal(calls.some((c) => c.startsWith("sudo -n install")), false, "no second unit is installed");
  assert.ok(calls.includes("sudo -n systemctl disable --now Kyber-buzz-bridge"), "the extra is switched off");
  assert.ok(calls.includes("sudo -n systemctl enable kyber-buzz-bridge"), "the running one is kept");
  assert.equal(units["other-buzz-bridge"].active, true, "another agent's bridge is left alone");

  const status = await setupStatus({ appRoot: dir, agent: "Kyber", options: { exec }, restarter: r });
  assert.equal(status.buzz.bridge, "active", "the page reads the bridge that is really running");
});
