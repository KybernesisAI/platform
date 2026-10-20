import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Updating a running agent to the newest certified packages, the way staff do
 * it by hand: `kyb upgrade` (every @kybernesis package to its newest build for
 * the certified eve, eve to the certified pin, the repairs, the eval gate),
 * then a rebuild and one safe restart.
 *
 * These are the pure parts: what the agent runs now, what an upgrade plans,
 * and a copy of everything an upgrade may touch so a failure puts it back.
 */

/**
 * The Kybernesis CLI that knows `upgrade --check`. A range, not `@latest`: an
 * older kyb ignores flags it does not know, so `upgrade --check` on it would
 * run a real upgrade.
 */
export const KYB_UPDATE = ["--yes", "--package=@kybernesis/create@>=0.24.0", "kyb"];

/** The line `kyb upgrade --check` prints for a program to read. */
export const UPGRADE_PLAN_PREFIX = "KYB_UPGRADE_PLAN ";

export interface PackageChange {
  name: string;
  from: string;
  to: string;
}

export interface UpgradePlan {
  ok: boolean;
  changes: PackageChange[];
  /** eve moves to a new certified version, which ends conversations still open. */
  resetsConversations: boolean;
  unresolved?: string[];
}

export function parseUpgradePlan(stdout: string): UpgradePlan | null {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith(UPGRADE_PLAN_PREFIX));
  if (!line) return null;
  try {
    const raw = JSON.parse(line.slice(UPGRADE_PLAN_PREFIX.length)) as Record<string, unknown>;
    const changes = Array.isArray(raw.changes)
      ? raw.changes.flatMap((c: unknown) => {
          const { name, from, to } = (c ?? {}) as Record<string, unknown>;
          return typeof name === "string" && typeof from === "string" && typeof to === "string" ? [{ name, from, to }] : [];
        })
      : [];
    return {
      ok: raw.ok === true,
      changes,
      resetsConversations: raw.resetsConversations === true,
      ...(Array.isArray(raw.unresolved) ? { unresolved: raw.unresolved.filter((u): u is string => typeof u === "string") } : {}),
    };
  } catch {
    return null;
  }
}

/** eve and every @kybernesis package the agent depends on, at the version installed now (null when missing). */
export function installedVersions(appRoot: string): Array<{ name: string; version: string | null }> {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const names = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])]
    .filter((n) => n === "eve" || n.startsWith("@kybernesis/"))
    .sort((a, b) => (a === "eve" ? -1 : b === "eve" ? 1 : a.localeCompare(b)));
  return names.map((name) => {
    try {
      const version = (JSON.parse(readFileSync(join(appRoot, "node_modules", name, "package.json"), "utf8")) as { version?: unknown }).version;
      return { name, version: typeof version === "string" ? version : null };
    } catch {
      return { name, version: null };
    }
  });
}

/** A stamp of what is installed, so a check made before someone else changed the agent is not trusted after. */
export function installedStamp(appRoot: string): string {
  return installedVersions(appRoot)
    .map((p) => `${p.name}@${p.version ?? "-"}`)
    .join(",");
}

/** Where an upgrade writes: the manifest, the lock, env, and the agent's own source, evals and scripts. */
const SNAPSHOT_FILES = ["package.json", "package-lock.json", ".env.local", "tsconfig.json"];
const SNAPSHOT_DIRS = ["agent", "evals", "scripts"];

export interface Snapshot {
  files: Map<string, { data: Buffer; mode: number }>;
}

function walk(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() || e.isSymbolicLink() ? [join(dir, e.name)] : [],
  );
}

function watched(appRoot: string): string[] {
  return [
    ...SNAPSHOT_FILES.map((f) => join(appRoot, f)).filter((p) => existsSync(p)),
    ...SNAPSHOT_DIRS.flatMap((d) => walk(join(appRoot, d))),
  ];
}

export function takeSnapshot(appRoot: string): Snapshot {
  const files = new Map<string, { data: Buffer; mode: number }>();
  for (const path of watched(appRoot)) {
    try {
      files.set(path, { data: readFileSync(path), mode: statSync(path).mode & 0o777 });
    } catch {
      /* vanished while reading: nothing to keep */
    }
  }
  return { files };
}

/** True when nothing the snapshot covers has changed. */
export function unchangedSince(appRoot: string, snap: Snapshot): boolean {
  const now = watched(appRoot);
  if (now.length !== snap.files.size) return false;
  return now.every((path) => {
    const kept = snap.files.get(path);
    if (!kept) return false;
    try {
      return readFileSync(path).equals(kept.data);
    } catch {
      return false;
    }
  });
}

/** Put every covered file back as it was: new ones removed, changed and removed ones rewritten. */
export function restoreSnapshot(appRoot: string, snap: Snapshot): void {
  for (const path of watched(appRoot)) if (!snap.files.has(path)) rmSync(path, { force: true });
  for (const [path, { data, mode }] of snap.files) {
    let same = false;
    try {
      same = readFileSync(path).equals(data);
    } catch {
      /* gone: rewrite it */
    }
    if (same) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    chmodSync(path, mode);
  }
}

/** The package names in a change list, for a sentence: "eve, @kybernesis/manage and 2 more". */
export function changeWords(changes: PackageChange[]): string {
  const names = changes.map((c) => c.name.replace(/^@kybernesis\//, ""));
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
