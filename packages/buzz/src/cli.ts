#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { buzzBridge } from "./bridge.js";
import { asHexPubkey, loadOrCreateKey, npubEncode } from "./keys.js";

/**
 * Setup and operation for an agent that lives in a workspace.
 *
 * @remarks
 * The commands are shaped around the one step that cannot be automated: a person in the
 * workspace has to invite the agent's public key, because membership is theirs to grant. So
 * `init` exists to produce exactly the thing they need to be given, and to say what to do with
 * it — rather than leaving an operator to work out which of several long hex strings is the one.
 */

const KEY_FILE = process.env.BUZZ_KEYFILE ?? join(homedir(), ".kybernesis", "buzz-agent.json");

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
}

function init(): void {
  const { key, created } = loadOrCreateKey(KEY_FILE);
  console.log(created ? `\n  A new identity was created at ${KEY_FILE}\n` : `\n  Using the identity at ${KEY_FILE}\n`);
  console.log(`  Invite this to the workspace:\n\n    ${key.npub}\n`);
  console.log(`  hex: ${key.publicKey}\n`);
  console.log("  Then, once it has been invited:\n");
  console.log("    KYBERNESIS_AGENT_CREDENTIAL=…  kybernesis-buzz run\n");
  console.log("  Anyone who talks to it is sent a sign-in link the first time, and after that");
  console.log("  their turns run as them.\n");
}

function run(): void {
  const bridge = buzzBridge({
    // Comma-separated: one agent can be a member of several communities, and
    // each is a connection rather than another process to supervise.
    relay: env("BUZZ_RELAY").split(",").map((url) => url.trim()).filter(Boolean),
    agentUrl: process.env.BUZZ_AGENT_URL ?? "http://127.0.0.1:8000",
    keyFile: KEY_FILE,
    issuer: env("KYBERNESIS_ISSUER", "https://agent.kybernesis.ai"),
    credential: env("KYBERNESIS_AGENT_CREDENTIAL"),
    ...(process.env.BUZZ_POLL_MS ? { pollMs: Number(process.env.BUZZ_POLL_MS) } : {}),
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      bridge.stop();
      setTimeout(() => process.exit(0), 400);
    });
  }
  bridge.start();
}

/** A systemd unit, written out rather than described — the description is what gets mistyped. */
function service(): void {
  const user = process.env.SUDO_USER ?? process.env.USER ?? "root";
  const workingDirectory = process.cwd();
  const unit = `[Unit]
Description=agent workspace bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workingDirectory}
ExecStart=/bin/bash -lc 'set -a && . ./.env.local && set +a && exec npx kybernesis-buzz run'
Restart=always
RestartSec=10
# The bridge publishes "offline" on the way out; this gives it time to, rather than
# being killed mid-publish and leaving a stopped agent showing as online.
KillSignal=SIGTERM
TimeoutStopSec=10
StartLimitBurst=5
StartLimitIntervalSec=300
StandardOutput=append:${workingDirectory}/buzz-bridge.log
StandardError=append:${workingDirectory}/buzz-bridge.log

[Install]
WantedBy=multi-user.target
`;
  const path = process.argv[3];
  if (path) {
    writeFileSync(path, unit);
    console.log(`\n  Written to ${path}\n`);
    console.log("  sudo systemctl daemon-reload && sudo systemctl enable --now <name>\n");
    return;
  }
  process.stdout.write(unit);
}

const command = process.argv[2];
if (command === "init") init();
else if (command === "run") run();
else if (command === "service") service();
else if (command === "id") {
  const hex = asHexPubkey(process.argv[3]);
  if (!hex) {
    console.error("usage: kybernesis-buzz id <npub… or 64-char hex>");
    process.exit(1);
  }
  console.log(`hex:  ${hex}`);
  console.log(`npub: ${npubEncode(hex)}`);
} else {
  console.log(`
  kybernesis-buzz — put an agent in a workspace

    init              create or show this agent's identity, and what to invite
    run               run the bridge
    service [path]    print (or write) a systemd unit for it
    id <npub|hex>     show a public key in both forms

  Environment:

    BUZZ_RELAY                     the workspace relay (wss://…), or several,
                                   comma-separated
    BUZZ_AGENT_URL                 where the agent listens (default http://127.0.0.1:8000)
    BUZZ_KEYFILE                   this agent's key (default ~/.kybernesis/buzz-agent.json)
    KYBERNESIS_ISSUER              the control plane
    KYBERNESIS_AGENT_CREDENTIAL    this agent's credential
`);
}
