import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * How many durable runs this host is carrying that nothing will ever finish
 * (KYB-546).
 *
 * eve leaves a run in `running` when a session, turn or task is abandoned, and
 * ships nothing that retires them. They accumulate — four figures per host after
 * a month — and every one is replayed at boot. After a durable-runtime change
 * those replays diverge, are declared CORRUPTED_EVENT_LOG, and the conversation
 * is dead for good.
 *
 * Reimplemented here rather than imported from @kybernesis/exe: doctor runs in
 * repos that do not depend on exe, and a diagnostic that cannot run where the
 * problem is is not a diagnostic. It only counts — retiring is exe's job.
 */
export interface RunStoreCount {
  abandoned: number;
  /** Held by a hook token: routine sessions live here and must never be retired. */
  held: number;
  total: number;
}

/** Count abandoned runs under an agent's `.eve/.workflow-data`, or null when there is no store. */
export function countAbandonedRuns(cwd: string, olderThanDays = 2, now = new Date()): RunStoreCount | null {
  const data = join(cwd, ".eve", ".workflow-data");
  const runsDir = join(data, "runs");
  let names: string[];
  try {
    names = readdirSync(runsDir).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }

  const held = new Set<string>();
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      try {
        const d = JSON.parse(readFileSync(full, "utf8")) as { runId?: unknown };
        if (typeof d.runId === "string" && d.runId !== "") held.add(d.runId);
      } catch {
        // Unreadable hook: count nothing rather than guess a run is unheld.
      }
    }
  };
  walk(join(data, "hooks"));

  const threshold = olderThanDays * 86_400_000;
  const out: RunStoreCount = { abandoned: 0, held: 0, total: names.length };
  for (const name of names) {
    let run: Record<string, unknown>;
    try {
      run = JSON.parse(readFileSync(join(runsDir, name), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (run.status !== "running") continue;
    if (typeof run.runId === "string" && held.has(run.runId)) {
      out.held += 1;
      continue;
    }
    const updated = typeof run.updatedAt === "string" ? Date.parse(run.updatedAt) : NaN;
    if (Number.isFinite(updated) && now.getTime() - updated >= threshold) out.abandoned += 1;
  }
  return out;
}
