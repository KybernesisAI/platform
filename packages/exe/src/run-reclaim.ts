import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Retire durable runs that were abandoned, so a host's workflow store stops
 * growing without bound (KYB-546).
 *
 * eve leaves a run file in `running` whenever a session, turn, or session-timeout
 * workflow is abandoned, and ships nothing that retires them — no prune, no gc,
 * no store maintenance. They accumulate for weeks: four figures per host after a
 * month of ordinary use. Two costs follow. Recovery replays every `running` run
 * at boot, and after a durable-runtime change those event logs diverge and are
 * declared CORRUPTED_EVENT_LOG — terminal, so that conversation can never take
 * another turn. And the disk only ever grows.
 *
 * Runs are marked **cancelled, never deleted**: the event log stays readable, so
 * an old conversation still replays in a client. This retires the pointer, not
 * the history.
 */

export interface ReclaimOptions {
  /** The `.eve/.workflow-data/runs` directory to sweep. */
  runsDir: string;
  /** Leave anything touched more recently than this. Default 2 days. */
  olderThanDays?: number;
  /** Write changes. Off by default — a reclaim that mutates on a dry run is not a dry run. */
  apply?: boolean;
  /** Clock seam, so a test does not have to sleep. */
  now?: Date;
  /**
   * Run ids something still holds a hook token for. These are NEVER retired,
   * however old they look — see `heldRunIds`.
   */
  held?: ReadonlySet<string>;
}

export interface ReclaimReport {
  retired: number;
  /** Kept because a hook still addresses them: routines live here. */
  keptHeld: number;
  /** Kept because they are within the threshold. */
  keptRecent: number;
  /** Already terminal; nothing to do. */
  keptTerminal: number;
  byWorkflow: Record<string, number>;
}

/**
 * The run ids a hook token still points at.
 *
 * A routine's session is one long-lived run left `running` between firings, with
 * a hook token the scheduler delivers into. It is *supposed* to sit untouched
 * for days — a weekly routine is idle for a week by design — so "running and
 * old" is precisely the wrong test for whether it is abandoned.
 *
 * Retiring one kills the routine, and kills it quietly: the schedule still
 * fires, so the logs show an attempted dispatch rather than a missing job, and
 * the only symptom is that the agent stopped saying anything. That happened —
 * three of four routines on a production agent, from a nightly sweep.
 */
export function heldRunIds(workflowDataDir: string): Set<string> {
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
        // A hook we cannot read is one we cannot prove is unheld. Skipping it
        // errs toward keeping runs, which is the safe direction.
      }
    }
  };
  walk(join(workflowDataDir, "hooks"));
  return held;
}

/** Only real work counts. A session-timeout workflow is a background timer and is always `running`. */
const RETIRABLE = ["workflowEntry", "turnWorkflow", "taskRunWorkflow", "sessionTimeoutWorkflow"];

export function reclaimAbandonedRuns(options: ReclaimOptions): ReclaimReport {
  const now = options.now ?? new Date();
  const threshold = (options.olderThanDays ?? 2) * 86_400_000;
  const held = options.held ?? new Set<string>();
  const report: ReclaimReport = { retired: 0, keptHeld: 0, keptRecent: 0, keptTerminal: 0, byWorkflow: {} };

  let names: string[];
  try {
    names = readdirSync(options.runsDir).filter((n) => n.endsWith(".json"));
  } catch {
    return report;
  }

  for (const name of names) {
    const file = join(options.runsDir, name);
    let run: Record<string, unknown>;
    try {
      run = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (run.status !== "running") {
      report.keptTerminal += 1;
      continue;
    }
    if (typeof run.runId === "string" && held.has(run.runId)) {
      report.keptHeld += 1;
      continue;
    }
    const updated = typeof run.updatedAt === "string" ? Date.parse(run.updatedAt) : NaN;
    // An unparseable timestamp is not evidence of abandonment.
    if (!Number.isFinite(updated) || now.getTime() - updated < threshold) {
      report.keptRecent += 1;
      continue;
    }
    const workflow = String(run.workflowName ?? "?").split("/").filter(Boolean).pop() ?? "?";
    if (!RETIRABLE.includes(workflow)) {
      report.keptRecent += 1;
      continue;
    }

    report.byWorkflow[workflow] = (report.byWorkflow[workflow] ?? 0) + 1;
    report.retired += 1;
    if (!options.apply) continue;

    const stamp = now.toISOString();
    const next = { ...run, status: "cancelled", updatedAt: stamp, completedAt: stamp };
    // Written beside and renamed: a reader arriving mid-write gets the old file
    // rather than half a JSON document.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), "utf8");
    renameSync(tmp, file);
  }
  return report;
}

/** One line for `kyb doctor`, or undefined when there is nothing worth saying. */
export function describeReclaim(report: ReclaimReport): string | undefined {
  if (report.retired === 0) return undefined;
  const kinds = Object.entries(report.byWorkflow)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}: ${c}`)
    .join(", ");
  return `${report.retired} abandoned durable run(s) could be retired (${kinds}). They are replayed at every boot and never removed; ${report.keptHeld} held by a hook were left alone.`;
}
