import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Services that are still running the code they loaded at start, after the
 * package on disk has moved underneath them.
 *
 * Node reads a module once, at process start. Upgrading a package therefore
 * changes nothing in a service that was already running — it keeps executing
 * the old code from memory while the new version sits on disk, indefinitely.
 *
 * An agent host has more than one service. `deploy.sh` restarts the agent, and
 * the Buzz bridge is a separate long-lived unit it does not touch. On the
 * reference fleet both bridges ran for four days on `@kybernesis/buzz` 0.9.2
 * while 0.9.9 was installed, so two fixes that had been signed off as deployed
 * were live nowhere. Nothing was broken enough to notice; the bridges simply
 * kept doing what the old code did.
 *
 * Checking the FILES is what hid it. The only honest question is whether the
 * process started after the package changed.
 */

export interface StaleSidecar {
  service: string;
  /** When the unit last started. */
  startedAt: Date;
  /** The newest package change it has not picked up. */
  packageChangedAt: Date;
  /** The package whose change is newest, for the message. */
  packageName: string;
}

/** The newest mtime across installed @kybernesis packages, and which one it was. */
export function newestPackageChange(cwd: string): { at: Date; name: string } | null {
  const scope = join(cwd, "node_modules", "@kybernesis");
  let newest: { at: Date; name: string } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(scope);
  } catch {
    return null;
  }
  for (const name of entries) {
    try {
      // The manifest is rewritten on every install of that package, so its
      // mtime is when the package last changed on this host.
      const at = statSync(join(scope, name, "package.json")).mtime;
      if (!newest || at > newest.at) newest = { at, name: `@kybernesis/${name}` };
    } catch {
      // A half-removed package tells us nothing; skip it.
    }
  }
  return newest;
}

/**
 * Compare each running unit's start time against the newest package change.
 *
 * `started` maps a unit name to when it started — supplied by the caller so
 * this stays testable and does not shell out.
 *
 * A grace margin avoids flagging the restart that an install performs itself:
 * a service restarted within a minute of the package landing has the new code.
 */
export function staleSidecars(input: {
  started: ReadonlyMap<string, Date>;
  packageChange: { at: Date; name: string } | null;
  graceMs?: number;
}): StaleSidecar[] {
  const change = input.packageChange;
  if (!change) return [];
  const grace = input.graceMs ?? 60_000;
  const out: StaleSidecar[] = [];
  for (const [service, startedAt] of input.started) {
    if (startedAt.getTime() >= change.at.getTime() - grace) continue;
    out.push({ service, startedAt, packageChangedAt: change.at, packageName: change.name });
  }
  return out;
}

/** One line per stale service, naming the fix. */
export function describeStaleSidecar(stale: StaleSidecar): string {
  const started = stale.startedAt.toISOString().slice(0, 16).replace("T", " ");
  const changed = stale.packageChangedAt.toISOString().slice(0, 16).replace("T", " ");
  return (
    `${stale.service} started ${started} but ${stale.packageName} changed ${changed} — ` +
    `it is still running the code it loaded at start. Restart it: sudo systemctl restart ${stale.service}`
  );
}
