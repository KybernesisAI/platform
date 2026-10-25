import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * One bridge per agent key.
 *
 * @remarks
 * Two bridges on one key are two members with the same face: each hears every
 * message and each runs the turn, so every question is asked of the agent
 * twice and answered twice. It happened when a second unit with a different
 * name was installed beside a running one, and nothing in either process
 * could tell. The lock is a file beside the key holding the pid that answers
 * as it; a second bridge waits for it instead of joining in.
 */
export function lockPathFor(keyFile: string): string {
  return `${keyFile}.bridge.lock`;
}

export type LockHolder = { pid: number };

/** Take the lock, or say who holds it. A lock left by a process that is gone is taken over. */
export function acquireBridgeLock(
  keyFile: string,
  pid = process.pid,
  isBridge: (pid: number) => boolean = isLiveBridge,
): { release: () => void } | { heldBy: LockHolder } {
  const path = lockPathFor(keyFile);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return {
        release: () => {
          try {
            if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    } catch {
      /* vanished between the two calls: try again */
    }
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && isBridge(holder)) return { heldBy: { pid: holder } };
    try {
      unlinkSync(path);
    } catch {
      /* someone else cleared it first */
    }
  }
  // Lost a race twice: whoever won holds it.
  return { heldBy: { pid: -1 } };
}

/**
 * Whether `pid` is a running bridge. A pid is reused after a reboot, so on
 * Linux the process's command line has to name the bridge too; elsewhere a
 * live pid is taken at its word.
 */
export function isLiveBridge(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("kybernesis-buzz");
  } catch {
    return process.platform !== "linux";
  }
}
