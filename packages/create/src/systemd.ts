import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { dim, green, yellow } from "./util.js";

export const LEGACY_RESTART_COMMAND = "bash scripts/eve-server.sh restart";

export function systemdRestartCommand(name: string): string {
  return `sudo -n systemctl restart ${name}-agent`;
}

export interface ManageRestartDiagnosis {
  verdict: "pass" | "warn" | "fail";
  label: string;
  detail?: string;
}

export function diagnoseManageRestart(
  serviceName: string | null,
  restartCommand: string | undefined,
): ManageRestartDiagnosis {
  if (!serviceName) {
    return restartCommand
      ? { verdict: "pass", label: "management routes can restart the agent after an install" }
      : {
          verdict: "warn",
          label: "management routes have no restartCommand",
          detail:
            "installing edits this repo and rebuilds; without a restart the response says a restart is still required. Install the systemd service, then use the exact restartCommand its installer prints",
        };
  }

  const desired = systemdRestartCommand(serviceName);
  const remediation =
    `set restartCommand in agent/channels/kyb.ts to ${JSON.stringify(desired)}. ` +
    `Verify passwordless sudo with: ${desired}. systemctl restart does not wait for an in-flight turn; an install can interrupt it.`;
  if (restartCommand === LEGACY_RESTART_COMMAND) {
    return {
      verdict: "fail",
      label: "management restart uses eve-server.sh while systemd owns the agent",
      detail: `this can start two servers against one durable store; ${remediation}`,
    };
  }
  if (restartCommand === desired) {
    return { verdict: "pass", label: `management routes restart the systemd owner (${serviceName}-agent)` };
  }
  if (restartCommand) {
    return {
      verdict: "warn",
      label: `management restartCommand is customized and was preserved (${JSON.stringify(restartCommand)})`,
      detail: `confirm it cannot start a second supervisor; ${remediation}`,
    };
  }
  return { verdict: "warn", label: "management routes have no restartCommand", detail: remediation };
}

export interface UnitValues {
  name: string;
  user: string;
  app: string;
  port: string;
}

export function parseAgentServiceUnit(path: string, contents: string): UnitValues | null {
  const fileName = /^(.+)-agent\.service$/.exec(basename(path))?.[1];
  const user = /^User=(.+)$/m.exec(contents)?.[1];
  const app = /^WorkingDirectory=(.+)$/m.exec(contents)?.[1];
  const port = /^Environment=PORT=(.+)$/m.exec(contents)?.[1];
  if (!fileName || !user || !app || !port) return null;
  return { name: fileName, user, app, port };
}

export type RestartMigration = "absent" | "missing" | "migrated" | "systemd" | "custom" | "blocked";

export function reconcileManageRestart(cwd: string, name: string): RestartMigration {
  const path = join(cwd, "agent/channels/kyb.ts");
  let before: string;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    return "absent";
  }

  const property = /\brestartCommand\s*:\s*(["'`])([^"'`]+)\1/m.exec(before);
  const configured = property?.[2];
  if (!configured) return "missing";
  if (configured === systemdRestartCommand(name)) return "systemd";
  if (configured !== LEGACY_RESTART_COMMAND || property?.[1] !== '"') return "custom";

  try {
    const replacement = property[0].replace(
      `${property[1]}${configured}${property[1]}`,
      JSON.stringify(systemdRestartCommand(name)),
    );
    writeFileSync(path, before.slice(0, property.index) + replacement + before.slice(property.index + property[0].length));
    return "migrated";
  } catch {
    return "blocked";
  }
}

export interface InstalledAgentService {
  path: string;
  contents: string;
  values: UnitValues;
  mode: number;
}

function dropIns(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".conf"))
      .sort()
      .map((name) => readFileSync(join(dir, name), "utf8"));
  } catch {
    return [];
  }
}

export function findMatchingAgentServiceUnit(
  cwd: string,
  systemdDir = "/etc/systemd/system",
): InstalledAgentService | null {
  try {
    for (const file of readdirSync(systemdDir).filter((entry) => entry.endsWith("-agent.service"))) {
      const path = join(systemdDir, file);
      // The effective unit is the file plus its drop-ins (<unit>.d/*.conf, in
      // name order) — a build gate added through `systemctl edit` counts.
      const contents = [readFileSync(path, "utf8"), ...dropIns(`${path}.d`)].join("\n");
      const values = parseAgentServiceUnit(path, contents);
      if (values && resolve(values.app) === resolve(cwd)) {
        return { path, contents, values, mode: statSync(path).mode & 0o777 };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function printRestartGuidance(state: RestartMigration, cwd: string, name: string): void {
  if (state === "absent" || state === "systemd") return;
  const desired = systemdRestartCommand(name);
  if (state === "migrated") {
    console.log(`  ${green("+")} migrated agent/channels/kyb.ts to ${desired}`);
  } else if (state === "custom" || state === "blocked") {
    console.log(
      `  ${yellow("!")} ${state === "blocked" ? "could not migrate" : "preserved customized"} restartCommand in agent/channels/kyb.ts. systemd owns ` +
        `this agent; scripts/eve-server.sh would create a second supervisor. Review it and use exactly:\n` +
        `    ${dim(`restartCommand: ${JSON.stringify(desired)},`)}\n` +
        `    ${dim(`Verify passwordless sudo with: ${desired}`)}\n` +
        `    ${dim("systemctl restart does not wait for an in-flight turn; an install can interrupt it.")}`,
    );
  } else {
    console.log(
      `  ${yellow("!")} ${join(cwd, "agent/channels/kyb.ts")} has no restartCommand. Add exactly:\n` +
        `    ${dim(`restartCommand: ${JSON.stringify(desired)},`)}\n` +
        `    ${dim("It needs passwordless sudo and can interrupt an in-flight turn.")}`,
    );
  }
}

/**
 * Refresh an existing package-generated unit. Deliberately never creates a
 * missing unit, enables it, or restarts it; upgrade only reconciles artifacts
 * whose systemd ownership is already established.
 */
/**
 * Once systemd owns the agent, a Studio install that restarts through
 * scripts/eve-server.sh starts a second supervisor beside it: the script
 * kills systemd's child and starts its own while Restart=always starts
 * another, and two executors race over one durable store. Migrate the exact
 * scaffolded literal in agent/channels/kyb.ts to the systemd restart; leave
 * anything an operator wrote, with the exact line to use.
 *
 * The unit itself is package-managed by repairHostArtifacts (managed marker,
 * .bak copy); this only follows what that unit implies for restarts.
 */
export function repairManageRestart(
  cwd: string,
  deps: Record<string, string>,
  systemdDir = "/etc/systemd/system",
): RestartMigration | null {
  if (!deps["@kybernesis/exe"]) return null;
  const match = findMatchingAgentServiceUnit(cwd, systemdDir);
  if (!match) return null;
  const state = reconcileManageRestart(cwd, match.values.name);
  printRestartGuidance(state, cwd, match.values.name);
  return state;
}
