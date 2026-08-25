#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buzzBridge } from "./bridge.js";
import { asHexPubkey, loadKey, loadOrCreateKey, npubEncode } from "./keys.js";
import * as profile from "./profile.js";

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

function relayList(): string[] {
  return env("BUZZ_RELAY")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

/** Take a `--flag value` off the argument list. */
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * Say who this agent is, in every community it belongs to.
 *
 * A member with no profile shows as a truncated public key. Each community
 * stores its own copy, so joining a second one means publishing again — which
 * is what `--copy-from` is for.
 */
async function setProfile(): Promise<void> {
  const key = loadKey(KEY_FILE);
  const urls = relayList();

  const source = flag("copy-from");
  if (source) {
    const copied = await profile.copy(source, urls, key);
    console.log(`\n  Copied ${copied.display_name ?? copied.name ?? "the profile"} from ${source} to:\n`);
    for (const url of urls.filter((url) => url !== source)) console.log(`    ${url}`);
    console.log();
    return;
  }

  const name = flag("name");
  if (!name) {
    console.error("usage: kybernesis-buzz profile --name <name> [--about …] [--picture <file|url>]");
    console.error("   or: kybernesis-buzz profile --copy-from <wss://…>");
    process.exit(1);
  }

  // A local file is uploaded to the community and becomes a URL; a URL is used
  // as given. Nobody should need storage of their own to give an agent a face.
  let picture = flag("picture");
  if (picture && !/^https?:\/\//.test(picture)) {
    const path = picture.startsWith("~/")
      ? join(homedir(), picture.slice(2))
      : picture;
    if (!existsSync(path)) {
      console.error(`\n  No such image: ${path}\n`);
      process.exit(1);
    }
    const bytes = readFileSync(path);
    let uploaded: string | undefined;
    for (const url of urls) {
      try {
        uploaded = await profile.uploadImage(url, key, bytes, profile.mediaTypeOf(path));
        console.log(`  uploaded ${path.split("/").pop()} to ${url}`);
        break;
      } catch (error) {
        console.log(`  · ${url} — ${(error as Error).message}`);
      }
    }
    if (!uploaded) {
      console.error("\n  Could not upload the image to any community.\n");
      process.exit(1);
    }
    picture = uploaded;
  }

  const wanted: profile.Profile = {
    name: name.toLowerCase().replace(/\s+/g, "-"),
    display_name: name,
    ...(flag("about") ? { about: flag("about") } : {}),
    ...(picture ? { picture } : {}),
    // Said plainly rather than left for people to work out.
    bot: true,
  };

  // Each community is asked separately, and one refusal does not stop the
  // others. Membership is per community, so being in one and not another is
  // the ordinary case rather than an error worth aborting on.
  let published = 0;
  for (const url of urls) {
    try {
      await profile.write(url, key, wanted);
      console.log(`  ✓ ${url}`);
      published += 1;
    } catch (error) {
      const why = (error as Error).message;
      console.log(
        why.includes("not a relay member")
          ? `  · ${url} — not a member yet, so nothing to be known as there`
          : `  ✕ ${url} — ${why}`,
      );
    }
  }
  console.log(
    published > 0
      ? `\n  ${name} is ${key.npub.slice(0, 20)}…\n`
      : "\n  Nothing published — invite this key to a community first.\n",
  );
}

function run(): void {
  const bridge = buzzBridge({
    // Comma-separated: one agent can be a member of several communities, and
    // each is a connection rather than another process to supervise.
    relay: relayList(),
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

/**
 * Put the Buzz CLI on this host, so the agent can act in the workspace.
 *
 * @remarks
 * The bridge gives an agent a voice; the CLI is how Buzz expects an agent to
 * DO anything — projects, issues, pull requests, notes, canvases. Its own
 * README is explicit: the harness prompts the agent, "and the agent replies
 * using the Buzz CLI".
 *
 * There is no published binary — the project releases desktop apps only — so
 * this builds one, from a pinned revision, in a container, and puts it where
 * the tool looks. That is a script's job and not a person's: the alternative
 * is a client being walked through a git checkout and a Rust toolchain, which
 * is not an answer anyone should give a customer.
 *
 * `BUZZ_CLI_URL` short-circuits the build for hosts that have no Docker: point
 * it at a binary built once for the same platform.
 */
async function installCli(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const { chmodSync, existsSync, mkdirSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");

  const target = resolve(process.env.BUZZ_CLI_PATH ?? ".buzz/bin/buzz");
  mkdirSync(dirname(target), { recursive: true });

  const url = process.env.BUZZ_CLI_URL;
  if (url) {
    console.log(`  downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not download the CLI (HTTP ${response.status})`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    chmodSync(target, 0o755);
    console.log(`  ✓ ${target}`);
    return;
  }

  try {
    execFileSync("docker", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "no docker on this host, and no BUZZ_CLI_URL set. Build the CLI once elsewhere for this " +
        "platform and point BUZZ_CLI_URL at it, or install docker.",
    );
  }

  // Pinned. A CLI that changes under a fleet on an unrelated restart is a
  // fleet whose behaviour changed for reasons nobody can reconstruct.
  const source = resolve(process.env.BUZZ_CLI_SRC ?? ".buzz/src");
  if (!existsSync(source)) {
    console.log("  fetching the CLI source (once)…");
    execFileSync("git", ["clone", "--depth", "1", "https://github.com/block/buzz.git", source], {
      stdio: "inherit",
    });
  }
  console.log("  building — a few minutes the first time, then cached…");
  execFileSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${source}:/src`,
      "-w", "/src",
      "rust:1-slim",
      "sh", "-c",
      "apt-get update -qq && apt-get install -y -qq pkg-config libssl-dev >/dev/null 2>&1; cargo build --release -p buzz-cli",
    ],
    { stdio: "inherit" },
  );

  const { copyFileSync } = await import("node:fs");
  copyFileSync(`${source}/target/release/buzz`, target);
  chmodSync(target, 0o755);
  console.log(`\n  ✓ ${target}`);
  console.log("    The agent finds it there automatically; set BUZZ_CLI_PATH to move it.");
}

const command = process.argv[2];
if (command === "profile") {
  setProfile().catch((error: Error) => {
    console.error(`\n  ${error.message}\n`);
    process.exit(1);
  });
} else if (command === "init") init();
else if (command === "run") run();
else if (command === "service") service();
else if (command === "install-cli") {
  installCli().catch((error: Error) => {
    console.error(`\n  ${error.message}\n`);
    process.exit(1);
  });
}
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

    init              create or show this agent's identity, and what to invite\n    install-cli       install the Buzz CLI, so the agent can act as well as talk
    profile           say who this agent is, in every community it belongs to
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
