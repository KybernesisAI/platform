import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { upsertEnv } from "./envfile.js";
import { buzzBridgeUnitsFor } from "./systemd.js";
import { bold, capture, dim, green, linePackage, red, run, yellow } from "./util.js";

/**
 * `kyb add buzz` — get an agent ready for its owner's Buzz community.
 *
 * @remarks
 * Buzz is not a channel file. The agent is a member of the community with its
 * own key, a separate bridge process hears mentions and answers as the person
 * who spoke, and an extension gives the agent the rest of the workspace. Every
 * one of those used to be a manual step on the host, so ticking Buzz on a build
 * did nothing at all.
 *
 * This does everything that does not depend on the customer: the package, the
 * extension mount, the agent's own key, the Buzz CLI and the bridge's unit. The
 * unit is left switched off, because the one thing only the customer can give
 * is which community it lives in. That arrives later through the owner's
 * Channels page (manage's `buzz.join`), which writes the relay, publishes the
 * agent's profile and starts the bridge.
 */

export const BUZZ_PACKAGE = linePackage("buzz");

export const BUZZ_EXTENSION_MOUNT =
  `// The agent's hands in Buzz: projects, issues, pull requests, patches, repos,\n` +
  `// long-form notes, channel canvases, workflows, the feed, media — everything the\n` +
  `// workspace has beyond talking, which the bridge alone does not provide.\n` +
  `//\n` +
  `// Actions are signed with THIS AGENT's key and appear under its name.\n` +
  `export { default } from "@kybernesis/buzz/extension";\n`;

/** Where the agent's Buzz key lives: inside the agent, so the bridge and the agent read the same file. */
export function buzzKeyPath(appDir: string): string {
  return join(appDir, ".buzz", "agent-key.json");
}

export function buzzBridgeUnitName(agent: string): string {
  return `${agent.toLowerCase()}-buzz-bridge`;
}

/** The bridge's systemd unit. Pure, so the test pins what every host gets. */
export function buzzBridgeUnit(input: { agent: string; user: string; appDir: string }): string {
  const { agent, user, appDir } = input;
  return `# Managed by @kybernesis/create (kyb add buzz). Switched on from the owner's Channels page.
[Unit]
Description=${agent} Buzz bridge
After=network-online.target ${agent}-agent.service
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${appDir}
# The relay, the key and the agent credential all come from .env.local, the
# same file the agent reads, so they can never disagree.
ExecStart=/bin/bash -lc 'set -a && . ./.env.local && set +a && exec npx kybernesis-buzz run'
Restart=always
RestartSec=10
# The bridge publishes "offline" on the way out; this gives it time to.
KillSignal=SIGTERM
TimeoutStopSec=10
StartLimitBurst=5
StartLimitIntervalSec=300
StandardOutput=append:${appDir}/buzz-bridge.log
StandardError=append:${appDir}/buzz-bridge.log

[Install]
WantedBy=multi-user.target
`;
}

export function addBuzz(cwd = resolve(process.cwd())): void {
  if (!existsSync(join(cwd, "package.json")) || !existsSync(join(cwd, "agent"))) {
    console.error(red("kyb add buzz: run this inside an agent directory."));
    process.exitCode = 1;
    return;
  }
  if (!existsSync(join(cwd, "scripts/eve-server.sh"))) {
    console.error(red("kyb add buzz: Buzz runs a bridge beside the agent, so it needs a host of its own (an exe VM or a server). This agent deploys to Vercel."));
    process.exitCode = 1;
    return;
  }
  const agent = agentNameOf(cwd);
  console.log(bold("kyb add buzz"));
  console.log(dim(`  agent: ${agent}`));

  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  if (!pkg.dependencies?.["@kybernesis/buzz"]) {
    run("npm", ["install", BUZZ_PACKAGE, "--no-audit", "--no-fund"], { cwd });
  }

  const mount = join(cwd, "agent/extensions/buzz.ts");
  if (!existsSync(mount)) {
    mkdirSync(join(cwd, "agent/extensions"), { recursive: true });
    writeFileSync(mount, BUZZ_EXTENSION_MOUNT);
    console.log(green("  + agent/extensions/buzz.ts"));
  }

  // One key for the bridge and the agent's tools. An existing BUZZ_KEYFILE is
  // kept: replacing a key is a new member the community never invited.
  const envPath = join(cwd, ".env.local");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const existing = env.match(/^BUZZ_KEYFILE\s*=\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  const keyFile = existing || buzzKeyPath(cwd);
  if (!existing) upsertEnv(cwd, { BUZZ_KEYFILE: keyFile });
  mkdirSync(join(keyFile, ".."), { recursive: true });
  ignore(cwd, ".buzz/");

  const init = capture("npx", ["kybernesis-buzz", "init"], cwd, { BUZZ_KEYFILE: keyFile });
  const npub = init?.match(/npub1[02-9ac-hj-np-z]+/)?.[0];
  if (!npub) {
    console.error(red("  Could not create the agent's Buzz identity (npx kybernesis-buzz init)."));
    process.exitCode = 1;
    return;
  }
  console.log(green(`  + Buzz identity ${npub}`));

  // The CLI is what the agent acts through; no binary is published, so it is
  // built once in a container. Without docker the agent can still talk.
  if (!existsSync(join(cwd, ".buzz/bin/buzz"))) {
    const hasDocker = capture("sh", ["-c", "command -v docker >/dev/null && echo yes"])?.trim() === "yes";
    if (hasDocker) {
      console.log(dim("  building the Buzz CLI for this host (first time only, a few minutes) …"));
      const ok = run("npx", ["kybernesis-buzz", "install-cli"], { cwd, allowFail: true, quiet: true, timeoutMs: 15 * 60_000 });
      console.log(ok ? green("  + Buzz CLI (.buzz/bin/buzz)") : yellow("  ! the Buzz CLI did not build; run: npx kybernesis-buzz install-cli"));
    } else {
      console.log(yellow("  ! no docker here, so the Buzz CLI was not built; the agent can talk in Buzz but not act in it."));
    }
  }

  // A bridge already serving this folder is this agent's bridge, whatever it is called.
  // Installing another beside it would answer every message twice.
  const existingUnits = buzzBridgeUnitsFor(cwd);
  if (existingUnits.length > 0) {
    console.log(dim(`  bridge: ${existingUnits.join(", ")} already serves this agent`));
    console.log(bold("\n  Next:"));
    console.log(`    · The owner connects it from the Channels page: their community's address, then an admin adds ${npub} as a member.`);
    return;
  }
  const unitName = buzzBridgeUnitName(agent);
  const dir = mkdtempSync(join(tmpdir(), "kyb-buzz-"));
  try {
    const file = join(dir, `${unitName}.service`);
    writeFileSync(file, buzzBridgeUnit({ agent, user: userInfo().username, appDir: cwd }));
    const installed =
      run("sudo", ["-n", "install", "-m", "644", file, `/etc/systemd/system/${unitName}.service`], { allowFail: true, quiet: true }) &&
      run("sudo", ["-n", "systemctl", "daemon-reload"], { allowFail: true, quiet: true });
    console.log(
      installed
        ? green(`  + ${unitName}.service (off until the owner connects a community)`)
        : yellow(`  ! could not install ${unitName}.service without a password; the owner's Connect step will need it`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(bold("\n  Next:"));
  console.log(`    · The owner connects it from the Channels page: their community's address, then an admin adds ${npub} as a member.`);
}

function agentNameOf(dir: string): string {
  const env = join(dir, ".env.local");
  if (existsSync(env)) {
    const hit = readFileSync(env, "utf8").match(/^KYBERNESIS_AGENT\s*=\s*"?([^"\n]+)"?/m);
    if (hit?.[1]) return hit[1].trim();
  }
  return basename(dir);
}

function ignore(dir: string, entry: string): void {
  const path = join(dir, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split("\n").some((line) => line.trim() === entry)) return;
  writeFileSync(path, `${current.replace(/\n*$/, "\n")}${entry}\n`);
}
