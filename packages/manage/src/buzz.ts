import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
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

/** The name a new bridge unit gets. Lower case: an agent called "Kyber" still gets `kyber-buzz-bridge`. */
export function bridgeUnitName(agent: string): string {
  return `${agent.toLowerCase()}-buzz-bridge`;
}

/**
 * The bridge units that serve this agent, found by the folder they run in.
 *
 * @remarks
 * A name built from the agent's name is a guess, and guessing wrong is not
 * harmless. An agent whose display name is "Kyber" looked for
 * `Kyber-buzz-bridge` beside a running `kyber-buzz-bridge`, reported Buzz as
 * off, and switching it on installed a second bridge on the same key. Two
 * bridges answer every message twice. The folder a unit runs in is what makes
 * it this agent's bridge, whatever it is called.
 *
 * `unit` is the one to use: the one named after the folder (what each agent's
 * deploy script restarts), then the one named after the agent, then any
 * other, a running one before a stopped one. `others` serve the same folder
 * and should not run beside it. With nothing serving the folder, `unit` is the
 * name a new one gets and `found` is false.
 */
export async function findBridgeUnits(
  exec: Exec,
  appRoot: string,
  agent: string,
): Promise<{ unit: string; others: string[]; found: boolean }> {
  const fresh = { unit: bridgeUnitName(agent), others: [], found: false };
  const listed = await exec(
    "systemctl",
    ["list-unit-files", "--type=service", "--no-legend", "--plain", "*buzz-bridge*.service"],
    { cwd: appRoot, timeoutMs: 10_000 },
  );
  if (listed.code !== 0) return fresh;
  const names = [...new Set(listed.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? ""))]
    .filter((name) => /^[\w@.-]+\.service$/.test(name))
    .map((name) => name.replace(/\.service$/, ""));
  const here = realPath(appRoot);
  const serving: { unit: string; active: boolean }[] = [];
  for (const unit of names) {
    const shown = await exec("systemctl", ["show", "-p", "WorkingDirectory", "--value", unit], { cwd: appRoot, timeoutMs: 10_000 });
    if (shown.code !== 0 || realPath(shown.stdout.trim()) !== here) continue;
    const active = (await exec("systemctl", ["is-active", unit], { cwd: appRoot, timeoutMs: 10_000 })).stdout.trim();
    serving.push({ unit, active: active === "active" || active === "activating" });
  }
  if (serving.length === 0) return fresh;
  const rank = (unit: string) =>
    unit === `${basename(appRoot)}-buzz-bridge` ? 0 : unit.toLowerCase() === bridgeUnitName(agent) ? 1 : 2;
  serving.sort((a, b) => Number(b.active) - Number(a.active) || rank(a.unit) - rank(b.unit) || a.unit.localeCompare(b.unit));
  // A running bridge is never traded for a stopped one, whatever the names say.
  return { unit: serving[0]!.unit, others: serving.slice(1).map((s) => s.unit), found: true };
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path.replace(/\/+$/, "");
  }
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
export async function installBridgeUnit(exec: Exec, cwd: string, agent: string, unit = bridgeUnitName(agent)): Promise<boolean> {
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
