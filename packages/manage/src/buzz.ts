import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Exec } from "./setup.js";

/**
 * Buzz from the owner's Channels page.
 *
 * @remarks
 * The agent joins its owner's Buzz community as a member with its own key. A
 * build (`kyb add buzz`) gives it that key, the tools and a bridge unit that
 * is switched off; what only the owner knows is which community. `buzz.join`
 * takes that address, writes it where the bridge and the agent both read it,
 * publishes the agent's name and picture there, and starts the bridge.
 *
 * Membership is the community's to grant, so the one step left is an admin
 * adding the agent's key. Joining again after that publishes the profile where
 * it could not before; it does not bounce a bridge that is already running.
 */

export type BridgeState = "active" | "inactive" | "failed" | "missing" | "unknown";

export interface RelayOutcome {
  url: string;
  member: boolean;
  detail?: string;
}

/** Up to five relays, `wss://` (an `https://` community address is taken as its relay). */
export function parseRelays(input: unknown): { ok: true; relays: string[] } | { ok: false; error: string } {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/) : [];
  const relays: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    let url: URL;
    try {
      url = new URL(entry.trim());
    } catch {
      return { ok: false, error: `${entry} is not a community address.` };
    }
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol !== "wss:") return { ok: false, error: `${entry} must start with wss:// or https://.` };
    if (url.username || url.password || url.search || url.hash) return { ok: false, error: `${entry} must be a plain address.` };
    const clean = `wss://${url.host}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
    if (!relays.includes(clean)) relays.push(clean);
  }
  if (!relays.length) return { ok: false, error: "relay is required: the community's address, like wss://yourteam.communities.buzz.xyz." };
  if (relays.length > 5) return { ok: false, error: "At most five communities." };
  return { ok: true, relays };
}

/** Where the key is: BUZZ_KEYFILE, else the bridge's own default. */
export function buzzKeyFile(get: (key: string) => string | undefined): string {
  return get("BUZZ_KEYFILE") || join(homedir(), ".kybernesis", "buzz-agent.json");
}

export function bridgeUnitName(agent: string): string {
  return `${agent}-buzz-bridge`;
}

/** The same unit `kyb add buzz` installs, for an agent built before it did. */
export function bridgeUnit(input: { agent: string; user: string; appDir: string }): string {
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
ExecStart=/bin/bash -lc 'set -a && . ./.env.local && set +a && exec npx kybernesis-buzz run'
Restart=always
RestartSec=10
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

/** What `kybernesis-buzz profile` printed, one outcome per relay. */
export function parseProfileOutput(text: string, relays: string[]): RelayOutcome[] {
  return relays.map((url) => {
    const line = text.split("\n").find((l) => l.includes(url)) ?? "";
    if (/✓/.test(line)) {
      const picture = /picture not sent: (.+)$/.exec(line)?.[1]?.trim();
      return picture ? { url, member: true, detail: `The picture did not go: ${picture}` } : { url, member: true };
    }
    if (/not a member yet/i.test(line)) return { url, member: false, detail: "Not a member yet: an admin adds the agent's key." };
    const why = line.split("—").slice(1).join("—").trim();
    return { url, member: false, detail: why || "Could not reach this community." };
  });
}

/** The @kybernesis/buzz this agent actually has installed, or null. */
export function installedBuzzVersion(appRoot: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, "node_modules", "@kybernesis", "buzz", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Whether this Buzz takes its face from the owner: `kybernesis-buzz profile --sync`, and a
 * bridge that keeps the name and picture set in the app in step on its own (0.11).
 */
export function buzzFollowsOwner(version: string | null): boolean {
  const [major, minor] = (version ?? "").split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major! > 0 || minor! >= 11;
}

export async function bridgeState(exec: Exec, cwd: string, unit: string): Promise<BridgeState> {
  const load = await exec("systemctl", ["show", "-p", "LoadState", "--value", unit], { cwd, timeoutMs: 10_000 });
  if (load.code !== 0) return "unknown";
  if (load.stdout.trim() === "not-found") return "missing";
  const active = (await exec("systemctl", ["is-active", unit], { cwd, timeoutMs: 10_000 })).stdout.trim();
  return active === "active" || active === "activating" ? "active" : active === "failed" ? "failed" : "inactive";
}

/** The agent's public key, read by the bridge's own CLI; null while it has none. */
export async function buzzIdentity(exec: Exec, cwd: string, keyFile: string): Promise<{ npub: string; hex: string } | null> {
  // init would make a key when there is none; a status read must never do that.
  if (!existsSync(keyFile)) return null;
  const out = await exec("npx", ["kybernesis-buzz", "init"], { cwd, timeoutMs: 60_000, env: { BUZZ_KEYFILE: keyFile } });
  const npub = out.stdout.match(/npub1[02-9ac-hj-np-z]+/)?.[0];
  const hex = out.stdout.match(/hex:\s*([0-9a-f]{64})/)?.[1];
  return npub && hex ? { npub, hex } : null;
}

/** Write and load the unit with the host's passwordless sudo, the way the agent's own restart works. */
export async function installBridgeUnit(exec: Exec, cwd: string, agent: string): Promise<boolean> {
  const unit = bridgeUnitName(agent);
  const dir = mkdtempSync(join(tmpdir(), "kyb-buzz-"));
  try {
    const file = join(dir, `${unit}.service`);
    writeFileSync(file, bridgeUnit({ agent, user: userInfo().username, appDir: cwd }));
    const put = await exec("sudo", ["-n", "install", "-m", "644", file, `/etc/systemd/system/${unit}.service`], { cwd, timeoutMs: 20_000 });
    if (put.code !== 0) return false;
    return (await exec("sudo", ["-n", "systemctl", "daemon-reload"], { cwd, timeoutMs: 30_000 })).code === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
