import type { Check } from "./doctor.js";

/**
 * Docker sandbox template containers: the ones still building, and the ones
 * left behind.
 *
 * eve builds each Docker sandbox template inside an `eve-sbx-tpl-*` container
 * on first start. A cold build (apt-get, pnpm, playwright with its browsers)
 * runs for minutes and prints nothing to the deploy log while it does. Two
 * things went wrong with that on one deployment (KYB-531):
 *
 * - the host start script judged the start on a 45-second clock and printed
 *   "FAILED to start" while the template was building, so the operator killed
 *   the start;
 * - the killed start left the container behind with `sleep 2147483647` as its
 *   only process, and while it existed every later `eve start` blocked forever
 *   at "initializing N sandbox templates" with nothing in any log to say why.
 *
 * Everything here reads one probe: each template container's name and how
 * many processes inside it are not `sleep`. Building means at least one; an
 * orphan means none.
 */
export interface TemplateContainer {
  name: string;
  /** Processes inside the container other than `sleep`. */
  liveProcesses: number;
}

/**
 * Shell that prints one `name count` line per `eve-sbx-tpl-*` container, or
 * nothing when Docker is absent. The same probe serves doctor (locally), the
 * deploy (over ssh), and the host start script.
 */
export const TEMPLATE_CONTAINER_PROBE = [
  "command -v docker >/dev/null 2>&1 || exit 0",
  "for c in $(docker ps --filter name=eve-sbx-tpl- --format '{{.Names}}' 2>/dev/null); do",
  "  live=$(docker top \"$c\" 2>/dev/null | tail -n +2 | awk '{print $8}' | grep -vc '^sleep$')",
  '  echo "$c ${live:-0}"',
  "done",
].join("\n");

export function parseTemplateContainers(output: string | null | undefined): TemplateContainer[] {
  return (output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("eve-sbx-tpl-"))
    .map((line) => {
      const [name, count] = line.split(/\s+/);
      return { name, liveProcesses: Number(count) || 0 };
    });
}

export function orphanedTemplates(containers: readonly TemplateContainer[]): TemplateContainer[] {
  return containers.filter((c) => c.liveProcesses === 0);
}

export function buildingTemplates(containers: readonly TemplateContainer[]): TemplateContainer[] {
  return containers.filter((c) => c.liveProcesses > 0);
}

/** The exact command that clears an orphan; printed as the remedy and run by the start script. */
export function removeOrphanCommand(name: string): string {
  return `docker rm -f ${name}`;
}

export function templateContainerDoctorChecks(containers: readonly TemplateContainer[]): Check[] {
  const orphans = orphanedTemplates(containers);
  const building = buildingTemplates(containers);
  const checks: Check[] = orphans.map((c) => ({
    verdict: "fail",
    label: `orphaned sandbox template container ${c.name}: every eve start will hang until it is removed`,
    detail: `its only process is sleep; a start was killed mid-build. Remove it: ${removeOrphanCommand(c.name)}`,
  }));
  if (building.length) {
    checks.push({
      verdict: "warn",
      label: `sandbox template building: ${building.map((c) => c.name).join(", ")}`,
      detail: "a cold build takes minutes and the server binds its port only after it finishes; do not restart",
    });
  }
  return checks;
}

export type RestartState = "healthy" | "failed" | "building" | "orphaned" | "quiet" | "waiting";

/**
 * What a deploy should conclude from the host right now.
 *
 * The log alone was the whole verdict before, and a template build is silent
 * in it. The template probe is the second witness: while something is building,
 * silence is progress and the wait goes on; an orphan with nothing building
 * and no server is a stuck host with a known remedy, not a slow one.
 */
export function assessRestart(input: {
  log: string;
  templates: readonly TemplateContainer[];
  quietMs: number;
  quietLimitMs: number;
}): { state: RestartState; detail?: string } {
  if (/health:\s*200/.test(input.log)) return { state: "healthy" };
  if (/FAILED/.test(input.log)) return { state: "failed" };
  const building = buildingTemplates(input.templates);
  if (building.length) {
    return { state: "building", detail: building.map((c) => c.name).join(", ") };
  }
  const orphans = orphanedTemplates(input.templates);
  if (orphans.length) {
    return {
      state: "orphaned",
      detail: orphans.map((c) => `${c.name} (remove it: ${removeOrphanCommand(c.name)})`).join("; "),
    };
  }
  if (input.quietMs > input.quietLimitMs) return { state: "quiet" };
  return { state: "waiting" };
}
