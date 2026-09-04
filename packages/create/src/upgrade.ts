import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { upsertEnv } from "./envfile.js";
import { reconcileHostArtifact } from "./host-artifacts.js";
import { findMatchingAgentServiceUnit, repairManageRestart } from "./systemd.js";
import { repairTerminalSandboxCleanupHooks } from "./sandbox-cleanup.js";
import { repairRemovedDefaultTools as repairRemovedDefaultTools_ } from "./removed-default-tools.js";

import { EVE_VERSION, bold, capture, dim, green, parseEnv, red, run, yellow } from "./util.js";
import { inspectEveAgent, type AgentInputLimit } from "./agent-limits.js";
import { remoteProjectPath, sshTarget } from "./deploy.js";
import { classifyModelReach } from "./model-reach.js";
import { checkSelfVersion, versionLt } from "./self-version.js";
import { LEGACY_GITHUB_TOOLS_MOUNT, githubToolsMountTs } from "./templates.js";
import {
  confirmEveUpgrade,
  inspectBuzzSessions,
  inspectDurableRuns,
  reconcileEvalScript,
} from "./upgrade-sessions.js";

export function agentInputLimitUpgradeMessage(limit: AgentInputLimit): string {
  switch (limit.kind) {
    case "explicit-numeric":
      return `Eve max input tokens/session: ${limit.value.toLocaleString("en-US")} (explicit; unchanged)`;
    case "explicit-uncapped":
      return "Eve max input tokens/session: uncapped (explicit; unchanged)";
    case "inherited":
      return `Eve max input tokens/session: ${limit.value.toLocaleString("en-US")} inherited — set limits.maxInputTokensPerSession explicitly in agent/agent.ts; upgrade will not rewrite authored source`;
    case "unresolved":
      return `Eve max input tokens/session: unresolved (${limit.reason}); authored source was not changed`;
  }
}

function reportAgentInputLimit(cwd: string): void {
  const envPath = join(cwd, ".env.local");
  const env = {
    ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}),
    ...(process.env as Record<string, string>),
  };
  const inspection = inspectEveAgent(cwd, env);
  const limit: AgentInputLimit = inspection?.limit ?? {
    kind: "unresolved",
    reason: "eve info --json failed",
  };
  const marker = limit.kind === "inherited" || limit.kind === "unresolved" ? yellow("!") : green("✓");
  console.log(`  ${marker} ${agentInputLimitUpgradeMessage(limit)}`);
}

/**
 * Raise the local queue's delivery timeouts on an agent that already exists.
 *
 * @remarks
 * Written as a repair rather than a warning because of what the bug looks like
 * from outside: the agent answers the same question twice, in two different
 * wordings, and no error appears in any log. Nobody reports that as a transport
 * problem, so a warning would be read past — and the correct value is not a
 * judgement call, it is "longer than a turn".
 *
 * Only for self-hosted agents. Hosted ones use real queue infrastructure and
 * never touch this transport, so the variables would be noise in their
 * environment.
 */
function repairLocalQueueTimeouts(cwd: string, deps: Record<string, string>): void {
  if (!deps["@kybernesis/exe"]) return;
  const path = join(cwd, ".env.local");
  if (!existsSync(path)) return;

  const text = readFileSync(path, "utf8");
  const missing = ["WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS", "WORKFLOW_LOCAL_BODY_TIMEOUT_MS"].filter(
    (name) => !new RegExp(`^${name}=`, "m").test(text),
  );
  if (missing.length === 0) return;

  upsertEnv(cwd, Object.fromEntries(missing.map((name) => [name, "900000"])));
  console.log(
    `  ${green("+")} raised the local queue delivery timeout in .env.local ${dim("(was 30s)")}\n` +
      `    ${dim("A delivery holds one connection open for the whole turn. Below this, any turn")}\n` +
      `    ${dim("slower than 30s was redelivered and its steps re-run — the agent answered twice.")}\n` +
      `    ${dim("Takes effect on the next server restart.")}\n`,
  );
}

/**
 * Finish a Buzz install that a version bump alone leaves half-done.
 *
 * @remarks
 * A capability that arrives in a package but needs four manual steps to switch
 * on has not really shipped. That is what happened here: `kyb upgrade` moved an
 * agent to a version whose whole point was acting in a workspace, and the agent
 * went on being unable to, because the extension was not mounted, the process
 * had none of the environment the bridge had, and the CLI was not on the host.
 * Everything looked upgraded and nothing was different.
 *
 * The person who hit it was an engineer with a terminal, and it still took a
 * hand-written prompt to sort out. A client would not have got there at all —
 * they would have concluded the feature did not work.
 *
 * So each of those is repaired here, from what the host can already tell us:
 * the bridge's own service file holds the relay and the identity, and the rest
 * is a file and a binary.
 */
function repairBuzzSetup(cwd: string, deps: Record<string, string>): void {
  if (!deps["@kybernesis/buzz"]) return;

  const done: string[] = [];

  // 1. The extension mount. Without it the tools do not exist, and nothing says so.
  const mount = join(cwd, "agent/extensions/buzz.ts");
  if (!existsSync(mount)) {
    mkdirSync(join(cwd, "agent/extensions"), { recursive: true });
    writeFileSync(
      mount,
      `// The agent's hands in Buzz: projects, issues, pull requests, patches, repos,
` +
        `// long-form notes, channel canvases, workflows, the feed, media — everything the
` +
        `// workspace has beyond talking, which the bridge alone does not provide.
` +
        `//
` +
        `// Actions are signed with THIS AGENT's key and appear under its name.
` +
        `export { default } from "@kybernesis/buzz/extension";
`,
    );
    done.push("mounted the Buzz extension (agent/extensions/buzz.ts)");
  }

  /**
   * 2. The environment. The bridge runs with the relay and the key; the AGENT
   * process runs with neither, because nothing ever needed it to until the
   * tools existed. Read from the service file rather than asked for, because
   * the answer is already on the host and a person retyping it will eventually
   * mistype it.
   */
  const envPath = join(cwd, ".env.local");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (!/^BUZZ_RELAY=/m.test(env)) {
    const unit = capture("sh", [
      "-c",
      "grep -ohE 'BUZZ_(RELAY|KEYFILE)=[^ \"]+' /etc/systemd/system/*buzz-bridge.service 2>/dev/null | head -2",
    ]);
    const values: Record<string, string> = {};
    for (const line of (unit ?? "").split("\n")) {
      const [name, ...rest] = line.trim().split("=");
      if (name && rest.length) values[name] = rest.join("=").replace(/^"|"$/g, "");
    }
    if (values.BUZZ_RELAY) {
      upsertEnv(cwd, {
        BUZZ_RELAY: values.BUZZ_RELAY,
        ...(values.BUZZ_KEYFILE ? { BUZZ_KEYFILE: values.BUZZ_KEYFILE } : {}),
      });
      done.push("gave the agent process the relay and identity its bridge already had");
    } else {
      console.log(
        `  ${yellow("!")} Buzz tools need BUZZ_RELAY and BUZZ_KEYFILE in .env.local — the same ` +
          `values the bridge service uses. Could not read them from this host.`,
      );
    }
  }

  // 3. The CLI itself. Built once, in a container, because no binary is published.
  if (!existsSync(join(cwd, ".buzz/bin/buzz"))) {
    const hasDocker = capture("sh", ["-c", "command -v docker >/dev/null && echo yes"])?.trim() === "yes";
    if (hasDocker) {
      console.log(dim("  building the Buzz CLI for this host (first time only, a few minutes) …"));
      const ok = run("npx", ["kybernesis-buzz", "install-cli"], { cwd, allowFail: true, quiet: true });
      done.push(ok ? "installed the Buzz CLI (.buzz/bin/buzz)" : "could NOT install the Buzz CLI — run: npx kybernesis-buzz install-cli");
    } else {
      console.log(
        `  ${yellow("!")} No docker here, so the Buzz CLI cannot be built. Without it the agent ` +
          `can read the workspace but not act in it. Install docker, or set BUZZ_CLI_URL to a ` +
          `binary built for this platform, then: npx kybernesis-buzz install-cli`,
      );
    }
  }

  if (done.length > 0) {
    console.log(`  ${green("+")} Buzz: ${done.join("; ")}`);
    console.log(`    ${dim("Takes effect after the next build and restart.")}\n`);
  }
}

/** Quote one argument for the manual shell commands printed after a failed repair. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * eve 0.39 removed glob and grep from the default tool set; see
 * removed-default-tools.ts. Runs before typecheck because a stale disable
 * file is a compile error from 0.39 on, and an upgrade must never leave an
 * agent that cannot build.
 */
function repairRemovedDefaultTools(cwd: string): void {
  const { removed, optedIn } = repairRemovedDefaultTools_(cwd);
  for (const file of removed) {
    console.log(`  ${green("-")} removed ${file} ${dim("(disabled a tool eve no longer provides by default; a compile error from eve 0.39)")}`);
  }
  for (const file of optedIn) {
    console.log(`  ${green("+")} wrote ${file} ${dim("(keeps the tool this scope had on eve 0.38)")}`);
  }
  if (removed.length || optedIn.length) console.log();
}

function repairSandboxCleanupHooks(cwd: string, deps: Record<string, string>): void {
  if (!deps["@kybernesis/exe"]) return;
  const added = repairTerminalSandboxCleanupHooks(cwd);
  if (added.length === 0) return;
  console.log(
    `  ${green("+")} installed terminal sandbox cleanup for ${added.length} agent scope(s) ` +
      `${dim("(completed and failed sessions only)")}\n`,
  );
}

export type GithubToolsMountRepair =
  | { kind: "missing" | "current" | "updated" | "customized" }
  | { kind: "error"; message: string };

/** Upgrade only the exact registry scaffold; authored GitHub policy is not ours. */
export function repairGithubToolsMount(cwd: string): GithubToolsMountRepair {
  const path = join(cwd, "agent/extensions/github.ts");
  if (!existsSync(path)) return { kind: "missing" };

  let current: string;
  try {
    current = readFileSync(path, "utf8");
  } catch (error) {
    return { kind: "error", message: `could not read agent/extensions/github.ts: ${(error as Error).message}` };
  }

  const desired = githubToolsMountTs();
  if (current === desired) return { kind: "current" };
  if (current !== LEGACY_GITHUB_TOOLS_MOUNT) return { kind: "customized" };

  const temp = `${path}.kyb-${process.pid}`;
  try {
    writeFileSync(temp, desired);
    renameSync(temp, path);
    return { kind: "updated" };
  } catch (error) {
    rmSync(temp, { force: true });
    return { kind: "error", message: `could not update agent/extensions/github.ts: ${(error as Error).message}` };
  }
}

function reportGithubToolsMountRepair(cwd: string): void {
  const result = repairGithubToolsMount(cwd);
  if (result.kind === "updated") {
    console.log(
      `  ${green("+")} updated agent/extensions/github.ts ` +
        `${dim("(GitHub tools stay off until GITHUB_TOKEN is set)")}`,
    );
  } else if (result.kind === "customized") {
    console.log(
      `  ${yellow("!")} agent/extensions/github.ts is customized, so it was left unchanged.\n` +
        `    To adopt the quiet no-token behavior, compare it with a new \`kyb init --engineer\` scaffold.`,
    );
  } else if (result.kind === "error") {
    console.log(`  ${yellow("!")} ${result.message}; leaving the file unchanged.`);
  }
}

/**
 * Keep package-owned host files synchronized with the package that installed them.
 *
 * Existing artifacts are compared even when the capability they support is
 * temporarily unavailable. Missing cron installation remains Docker-gated, and
 * a missing systemd unit remains an explicit operator choice.
 */
function repairHostArtifacts(cwd: string, deps: Record<string, string>): void {
  if (!deps["@kybernesis/exe"]) return;

  const scripts = join(cwd, "node_modules/@kybernesis/exe/scripts");
  const pruneSource = join(scripts, "docker-prune.sh");
  const pruneTarget = "/etc/cron.daily/kyb-docker-prune";
  const hasDocker =
    capture("sh", ["-c", "command -v docker >/dev/null && echo yes"])?.trim() === "yes";

  // The host start script is package-owned too. It carried a 45-second
  // verdict clock that called a cold sandbox template build a failure, and no
  // sweep for the orphaned template container that a killed start leaves
  // behind (KYB-531). An agent still running the copy `kyb init` made keeps
  // both faults until something refreshes it; this does, on every upgrade.
  const serverSource = join(scripts, "eve-server.sh");
  const serverTarget = join(cwd, "scripts/eve-server.sh");
  if (existsSync(serverSource) && existsSync(serverTarget)) {
    reconcileHostArtifact({
      targetPath: serverTarget,
      desiredContent: readFileSync(serverSource),
      expectedMode: 0o755,
      installIfMissing: false,
      owner: "@kybernesis/exe/scripts/eve-server.sh",
      update: () => {
        try {
          copyFileSync(serverSource, serverTarget);
          chmodSync(serverTarget, 0o755);
          return true;
        } catch {
          return false;
        }
      },
      manualCommand: `cp ${shellQuote(serverSource)} scripts/eve-server.sh && chmod +x scripts/eve-server.sh`,
    });
  }

  if (existsSync(pruneSource)) {
    const pruneResult = reconcileHostArtifact({
      targetPath: pruneTarget,
      desiredContent: readFileSync(pruneSource),
      expectedMode: 0o755,
      installIfMissing: hasDocker,
      owner: "@kybernesis/exe/scripts/docker-prune.sh",
      update: () =>
        run("sudo", ["-n", "install", "-m", "0755", pruneSource, pruneTarget], {
          cwd,
          allowFail: true,
          quiet: true,
        }),
      manualCommand: `sudo install -m 0755 ${shellQuote(pruneSource)} ${pruneTarget}`,
    });

    if ((pruneResult === "current" || pruneResult === "updated") && existsSync("/etc/cron.weekly/docker-prune")) {
      const removed = run("sudo", ["-n", "rm", "-f", "/etc/cron.weekly/docker-prune"], {
        cwd,
        allowFail: true,
        quiet: true,
      });
      if (!removed) {
        console.log(
          `  ${yellow("!")} the daily docker reclaim is current, but the legacy weekly job remains. Run:\n` +
            `    ${dim("sudo rm -f /etc/cron.weekly/docker-prune")}`,
        );
      }
    }
  }

  const serviceScript = join(scripts, "install-service.sh");
  if (!existsSync(serviceScript)) return;
  const unitTarget = capture("bash", [serviceScript, "--unit-path"], cwd)?.trim();
  const unitContent = capture("bash", [serviceScript, "--print-unit"], cwd);
  const marker = capture("bash", [serviceScript, "--managed-marker"], cwd)?.trim();
  if (!unitTarget || unitContent === null || !marker) return;

  /**
   * Only a unit this package wrote is this package's to rewrite.
   *
   * Every host from before the installer existed has a hand-written unit —
   * some with Environment= lines the renderer knows nothing about. Reconciling
   * those would report "drifted (content)" and replace them, and a warning
   * that scrolls past in the middle of an upgrade is not consent. The marker
   * is the first line of every generated unit; a unit without it is reported
   * and left exactly as it is.
   */
  if (existsSync(unitTarget)) {
    let installed: string;
    try {
      installed = readFileSync(unitTarget, "utf8");
    } catch (error) {
      console.log(
        `  ${yellow("!")} could not read ${unitTarget} to check whether it is package-managed ` +
          `(${(error as Error).message}); leaving it alone.`,
      );
      return;
    }
    if (!installed.includes(marker)) {
      console.log(
        `  ${yellow("!")} ${unitTarget} was not written by @kybernesis/exe, so it was left as is.\n` +
          `    To adopt the package-managed unit (the current file is kept at ${unitTarget}.bak):\n` +
          `    ${dim(`bash ${shellQuote(serviceScript)} --refresh-unit`)}\n` +
          `    Host-specific settings belong in a drop-in: ${dim(`sudo systemctl edit <name>-agent`)}`,
      );
      return;
    }
  }

  reconcileHostArtifact({
    targetPath: unitTarget,
    desiredContent: Buffer.from(unitContent),
    expectedMode: 0o644,
    installIfMissing: false,
    owner: "@kybernesis/exe/scripts/install-service.sh",
    update: () =>
      run("env", ["KYB_NONINTERACTIVE=1", "bash", serviceScript, "--refresh-unit"], {
        cwd,
        allowFail: true,
        quiet: true,
      }),
    manualCommand: `bash ${shellQuote(serviceScript)} --refresh-unit`,
  });
}

export interface UpgradeOptions {
  allowStale?: boolean;
  host?: true | string;
  skipEval?: boolean;
  yes?: boolean;
}

function repairEvalCommand(cwd: string): void {
  const packagePath = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
  const result = reconcileEvalScript(pkg.scripts?.eval);
  if (result.kind === "updated") {
    pkg.scripts = { ...pkg.scripts, eval: result.script };
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`  ${green("+")} updated scripts.eval to run through kyb-eval`);
    return;
  }
  if (result.kind === "current") return;
  const current = result.kind === "custom" ? result.script : "(missing)";
  console.log(
    `  ${yellow("!")} scripts.eval is not a recognized direct eve eval command, so it was left unchanged.\n` +
      `    Manual remediation: make this command invoke kyb-eval instead of eve eval, preserving its setup and arguments.\n` +
      `    Current scripts.eval: ${dim(JSON.stringify(current))}`,
  );
}

const EVAL_GATE_UNAVAILABLE_EXIT = 2;
const DEFAULT_EXE_MODELS_URL = "https://llm.int.exe.xyz/models.json";

type EvalGatePreflight =
  | { kind: "ready" }
  | { kind: "unavailable"; reasons: string[] };

function evalGateEnvironment(cwd: string): Record<string, string> {
  const envPath = join(cwd, ".env.local");
  return {
    ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}),
    ...(process.env as Record<string, string>),
  };
}

async function routeAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(6000) });
    return true;
  } catch {
    return false;
  }
}

async function claudeSubscriptionProxyReady(cwd: string): Promise<boolean> {
  const module = join(cwd, "node_modules/@kybernesis/exe/dist/claude.js");
  if (!existsSync(module)) return false;
  try {
    const loaded = (await import(pathToFileURL(module).href)) as {
      claudeProxyReady?: () => Promise<{ ok: boolean }>;
    };
    if (typeof loaded.claudeProxyReady !== "function") return false;
    return (await loaded.claudeProxyReady()).ok;
  } catch {
    return false;
  }
}

/** Resolve an exe-backed judge from the provider the authored config actually calls. */
function exeJudgeUrl(cwd: string, env: Record<string, string>): string | null | undefined {
  const paths = [join(cwd, "evals/evals.config.ts"), join(cwd, "evals.config.ts")];
  const path = paths.find((candidate) => existsSync(candidate));
  if (!path) return null;
  const source = readFileSync(path, "utf8");
  const judgeProvider = /judge\s*:\s*\{[\s\S]*?model\s*:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(source)?.[1];
  if (!judgeProvider) return null;
  const escaped = judgeProvider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const providerBody = new RegExp(`(?:const|let)\\s+${escaped}\\s*=\\s*create[A-Za-z]+\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`).exec(source)?.[1];
  if (!providerBody) return /EXE_LLM_URL|llm\.int\.exe\.xyz/.test(source) ? undefined : null;
  if (/EXE_LLM_URL/.test(providerBody)) return env.EXE_LLM_URL || DEFAULT_EXE_MODELS_URL;
  const baseUrl = /baseURL\s*:\s*["']([^"']+)["']/.exec(providerBody)?.[1];
  if (baseUrl?.includes("llm.int.exe.xyz")) return baseUrl;
  return null;
}

export async function preflightEvalGate(cwd: string): Promise<EvalGatePreflight> {
  const env = evalGateEnvironment(cwd);
  const agentPath = join(cwd, "agent/agent.ts");
  const authoredSource = existsSync(agentPath) ? readFileSync(agentPath, "utf8") : null;
  const inspection = inspectEveAgent(cwd, env);
  const reach = classifyModelReach(authoredSource, inspection?.modelRouting ?? {
    kind: "unresolved",
    reason: "eve info failed before compiled model routing could be inspected",
  });
  const reasons: string[] = [];

  switch (reach.kind) {
    case "claude-sub":
      if (!(await claudeSubscriptionProxyReady(cwd))) reasons.push("the agent model proxy is unreachable");
      break;
    case "exe":
      if (!(await routeAnswers(env.EXE_LLM_URL || DEFAULT_EXE_MODELS_URL))) reasons.push("the agent model route is unreachable");
      break;
    case "unresolved":
      reasons.push(`the agent model route could not be resolved (${reach.reason})`);
      break;
    case "grok-sub":
    case "gateway":
    case "direct-provider":
      break;
  }

  const judgeUrl = exeJudgeUrl(cwd, env);
  if (judgeUrl === undefined) reasons.push("the eve judge route could not be resolved");
  else if (judgeUrl && !(await routeAnswers(judgeUrl))) reasons.push("the eve judge is unreachable");

  return reasons.length === 0 ? { kind: "ready" } : { kind: "unavailable", reasons };
}

function hostEvalCommand(cwd: string, target?: string): string {
  const host = target ?? "<host>";
  return `ssh ${host} ${shellQuote(`cd ${remoteProjectPath(cwd)} && npm run eval`)}`;
}

function reportEvalGateUnavailable(cwd: string, target: string | null, reasons: string[]): void {
  console.log(`\n${yellow("The eval gate for this agent can only run on its host (the model proxy and the eve judge are only reachable there).")}`);
  for (const reason of reasons) console.log(`  ${dim(reason)}`);
  console.log(`Run it there: ${bold(hostEvalCommand(cwd, target ?? undefined))}\n`);
  process.exitCode = EVAL_GATE_UNAVAILABLE_EXIT;
}

async function runUpgradeEvalGate(cwd: string, host: true | string | undefined): Promise<void> {
  if (host !== undefined) {
    const target = sshTarget(cwd, typeof host === "string" && host.length > 0 ? host : undefined);
    if (!target) {
      reportEvalGateUnavailable(cwd, null, ["no ssh target is configured"]);
      return;
    }
    console.log(bold(`\nRunning the eval gate on ${target} (${remoteProjectPath(cwd)}) — deploy only on green …\n`));
    const result = spawnSync("ssh", [target, `cd ${remoteProjectPath(cwd)} && npm run eval`], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    if (result.status === 0) {
      console.log(`\n${green("✓ Upgrade green.")} Deploy with: ${bold("npx eve deploy")}\n`);
    } else {
      console.log(`\n${red("✗ Evals failed after upgrade.")} Do NOT deploy — inspect .eve/evals/ artifacts on the host.\n`);
      process.exitCode = 1;
    }
    return;
  }

  const preflight = await preflightEvalGate(cwd);
  if (preflight.kind === "unavailable") {
    reportEvalGateUnavailable(cwd, sshTarget(cwd), preflight.reasons);
    return;
  }

  console.log(bold("\nRunning the eval gate (npm run eval) — deploy only on green …\n"));
  const ok = run("npm", ["run", "eval"], { cwd, allowFail: true });
  if (ok) {
    console.log(`\n${green("✓ Upgrade green.")} Deploy with: ${bold("npx eve deploy")}\n`);
  } else {
    console.log(`\n${red("✗ Evals failed after upgrade.")} Do NOT deploy — inspect .eve/evals/ artifacts.\n`);
    process.exitCode = 1;
  }
}

function upgradeEnvironment(cwd: string): Record<string, string | undefined> {
  const envPath = join(cwd, ".env.local");
  const env: Record<string, string | undefined> = {
    ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}),
    ...process.env,
  };
  if (!env.BUZZ_SESSIONS_FILE && !env.BUZZ_KEYFILE) {
    const unit = capture("sh", [
      "-c",
      "grep -ohE 'BUZZ_(SESSIONS_FILE|KEYFILE)=[^ \" ]+' /etc/systemd/system/*buzz-bridge.service 2>/dev/null | head -1",
    ]);
    const [name, ...value] = (unit ?? "").trim().split("=");
    if (name && value.length > 0) env[name] = value.join("=").replace(/^\"|\"$/g, "");
  }
  return env;
}

async function approveEveChange(cwd: string, yes: boolean, hasBuzz: boolean): Promise<boolean> {
  const durable = inspectDurableRuns(cwd);
  console.log(bold(`\nThis will reset ${durable.runningRunIds.length} open conversations`));
  if (durable.issues.length > 0) {
    console.log(
      `  ${yellow("!")} Durable-store inspection was incomplete; the count includes only readable records ` +
        `whose status is exactly "running".`,
    );
    for (const issue of durable.issues) console.log(`    ${dim(issue)}`);
  }

  if (hasBuzz) {
    const buzz = inspectBuzzSessions(cwd, upgradeEnvironment(cwd), durable.runningRunIds);
    if (buzz.matches.length > 0) {
      console.log("  Buzz-bound open conversations:");
      for (const match of buzz.matches) {
        console.log(`    ${match.runId} ${dim(`(${match.community} | ${match.channel})`)}`);
      }
    } else if (buzz.issue) {
      console.log(`  ${yellow("!")} Buzz session metadata unavailable: ${buzz.issue}`);
    } else {
      console.log(`  ${dim("No open durable conversations were matched to Buzz session metadata.")}`);
    }
  }

  const approved = await confirmEveUpgrade({ yes });
  if (!approved) {
    console.log(
      `\n${red("Eve upgrade cancelled before installation.")} ` +
        `${dim("Pass --yes for deliberate noninteractive use.")}\n`,
    );
  }
  return approved;
}

type DependencySection = "dependencies" | "devDependencies";

interface UpgradeTarget {
  name: string;
  section: DependencySection;
  currentRange: string;
  installedVersion: string;
  targetVersion: string;
  installedEvePeer?: string;
  targetEvePeer?: string;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function commandResult(command: string, args: string[], cwd: string, print = true): CommandResult {
  console.log(dim(`  $ ${command} ${args.join(" ")}`));
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (print) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  return { status: result.status ?? 1, stdout, stderr };
}

function fail(message: string): void {
  console.error(red(message));
  process.exitCode = 1;
}

function majorMinor(version: string): [number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) ? [major, minor] : null;
}

function installedPackageValue(cwd: string, name: string, expression: string): string | null {
  const packageName = JSON.stringify(`${name}/package.json`);
  return capture("node", ["-p", `require(${packageName})${expression}`], cwd)?.trim() || null;
}

function targetEvePeer(name: string, version: string): string | undefined {
  return capture("npm", ["view", `${name}@${version}`, "peerDependencies.eve"])?.trim() || undefined;
}

function dependencyEntries(pkg: Record<string, unknown>): Array<{ name: string; section: DependencySection; range: string }> {
  const entries: Array<{ name: string; section: DependencySection; range: string }> = [];
  for (const section of ["dependencies", "devDependencies"] as const) {
    const values = pkg[section] as Record<string, string> | undefined;
    for (const [name, range] of Object.entries(values ?? {})) {
      if (name === "eve" || name.startsWith("@kybernesis/")) entries.push({ name, section, range });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.section.localeCompare(b.section));
}

function rewriteManifest(cwd: string, pkg: Record<string, unknown>, targets: UpgradeTarget[]): void {
  for (const target of targets) {
    const section = pkg[target.section] as Record<string, string>;
    // eve is pinned exactly: the pin IS the certification. A caret let a
    // clean install resolve eve@0.49.1 against a certified 0.49.0 (blind
    // latest, the one thing kyb upgrade exists to prevent).
    section[target.name] = target.name === "eve" ? target.targetVersion : `^${target.targetVersion}`;
  }
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function recoveryGuidance(targets: UpgradeTarget[], bridgeUnit?: string): void {
  console.log(
    `\n${yellow("The dependency tree was not verified. Complete the clean install before using it:")}\n` +
      `  1. Ensure every root @kybernesis/* range in package.json is the resolved ^version, and eve is pinned exactly to ${EVE_VERSION}.\n` +
      `  2. ${dim("rm -rf node_modules")}\n` +
      `  3. ${dim("rm -f package-lock.json")}\n` +
      `  4. ${dim("npm install")}\n` +
      `  5. ${dim("npm ls eve")}`,
  );
  const peerChanges = targets.filter(
    (target) =>
      target.name.startsWith("@kybernesis/") &&
      target.installedEvePeer !== target.targetEvePeer &&
      (target.installedEvePeer !== undefined || target.targetEvePeer !== undefined),
  );
  if (peerChanges.length > 0) {
    console.log("\n  Published Eve peer metadata changed for these root packages:");
    for (const target of peerChanges) {
      console.log(
        `    ${target.name}: ${target.installedVersion} peers on ${target.installedEvePeer ?? "(none)"}; ` +
          `${target.targetVersion} peers on ${target.targetEvePeer ?? "(none)"}`,
      );
    }
    console.log(dim("  These are metadata facts, not an attribution of npm's reported conflict."));
  }
  if (bridgeUnit) {
    console.log(`\n  The Buzz bridge remains stopped until the tree is verified. Then run:\n    ${dim(`sudo -n systemctl start ${bridgeUnit}`)}`);
  }
}

function buzzBridgeUnit(cwd: string): string | null {
  const systemdDir = process.env.KYB_SYSTEMD_DIR;
  const match = findMatchingAgentServiceUnit(cwd, systemdDir || undefined);
  return match ? `${match.values.name}-buzz-bridge.service` : null;
}

function stopActiveBridge(cwd: string, unit: string | null): string | null | false {
  if (!unit) return null;
  const active = commandResult("systemctl", ["is-active", "--quiet", unit], cwd, false);
  if (active.status !== 0) return null;
  const stopped = commandResult("sudo", ["-n", "systemctl", "stop", unit], cwd);
  if (stopped.status === 0) return unit;
  fail(`Could not stop the active Buzz bridge. Run exactly:\n  sudo -n systemctl stop ${unit}`);
  return false;
}

function startStoppedBridge(cwd: string, unit: string): boolean {
  const started = commandResult("sudo", ["-n", "systemctl", "start", unit], cwd);
  if (started.status === 0) return true;
  fail(
    `Could not restart the Buzz bridge. Run exactly:\n` +
      `  sudo -n systemctl start ${unit}\n` +
      `  systemctl status ${unit}`,
  );
  return false;
}

export async function upgrade(options: UpgradeOptions = {}): Promise<void> {
  console.log(bold("\nkyb upgrade — checking @kybernesis/* and eve against npm\n"));
  const selfVersion = checkSelfVersion();
  if (selfVersion.kind === "stale") {
    console.log(`  ${yellow("!")} ${selfVersion.message}`);
    console.log(`    ${dim(selfVersion.fix)}\n`);
    if (!options.allowStale) {
      process.exitCode = 1;
      return;
    }
  }

  const cwd = process.cwd();
  const packagePath = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
  const deps = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  };

  reportAgentInputLimit(cwd);

  const entries = dependencyEntries(pkg);
  const installedVersions = new Map<string, string>();
  const targetVersions = new Map<string, string>();
  const installedPeers = new Map<string, string | undefined>();
  const targetPeers = new Map<string, string | undefined>();
  const unresolved = new Set<string>();

  for (const name of [...new Set(entries.map((entry) => entry.name))]) {
    const installed = installedPackageValue(cwd, name, ".version");
    if (!installed) {
      console.log(`  ${yellow("!")} ${name}: could not resolve installed version`);
      unresolved.add(name);
      continue;
    }
    installedVersions.set(name, installed);

    const target = name === "eve" ? EVE_VERSION : capture("npm", ["view", name, "version"])?.trim();
    if (!target) {
      console.log(`  ${yellow("!")} ${name}: could not resolve target version`);
      unresolved.add(name);
      continue;
    }
    targetVersions.set(name, target);

    if (name.startsWith("@kybernesis/")) {
      installedPeers.set(name, installedPackageValue(cwd, name, ".peerDependencies?.eve || ''") ?? undefined);
      targetPeers.set(name, targetEvePeer(name, target));
    }

    if (installed === target) {
      console.log(`  ${green("✓")} ${name}@${installed} ${dim(name === "eve" ? "(certified)" : "(latest)")}`);
    } else if (name === "eve" && versionLt(EVE_VERSION, installed)) {
      console.log(`  ${yellow("!")} eve@${installed} is AHEAD of the certified ${EVE_VERSION} ${dim("— unsupported territory")}`);
    } else {
      console.log(
        `  ${yellow("↑")} ${name}: ${installed} → ${target}` +
          (name === "eve" ? ` ${dim("(Kybernesis-certified)")}` : ""),
      );
    }
  }

  const eveInstalled = installedVersions.get("eve");
  const eveLatest = capture("npm", ["view", "eve", "version"])?.trim();
  if (eveLatest && versionLt(EVE_VERSION, eveLatest)) {
    console.log(dim(`    note: eve@${eveLatest} exists upstream; ${EVE_VERSION} is the newest Kybernesis-certified version.`));
  }

  if (unresolved.size > 0) {
    fail(
      `\nUpgrade planning failed for ${[...unresolved].sort().join(", ")}. ` +
        `No manifest, dependency tree, or service state was changed.`,
    );
    return;
  }

  const targets: UpgradeTarget[] = entries.map((entry) => ({
    name: entry.name,
    section: entry.section,
    currentRange: entry.range,
    installedVersion: installedVersions.get(entry.name)!,
    targetVersion: targetVersions.get(entry.name)!,
    installedEvePeer: installedPeers.get(entry.name),
    targetEvePeer: targetPeers.get(entry.name),
  }));

  const eveTarget = targetVersions.get("eve");
  const installedMajorMinor = eveInstalled ? majorMinor(eveInstalled) : null;
  const targetMajorMinor = eveTarget ? majorMinor(eveTarget) : null;
  if ((eveInstalled && !installedMajorMinor) || (eveTarget && !targetMajorMinor)) {
    fail(`Cannot safely compare Eve versions ${JSON.stringify(eveInstalled)} and ${JSON.stringify(eveTarget)}.`);
    return;
  }
  const eveChanged = Boolean(eveInstalled && eveTarget && versionLt(eveInstalled, eveTarget));
  const cleanInstall = Boolean(
    eveChanged &&
      installedMajorMinor &&
      targetMajorMinor &&
      (installedMajorMinor[0] !== targetMajorMinor[0] || installedMajorMinor[1] !== targetMajorMinor[1]),
  );

  const changed = [...new Set(targets
    .filter((target) => target.installedVersion !== target.targetVersion && !(target.name === "eve" && versionLt(target.targetVersion, target.installedVersion)))
    .map((target) => `${target.name}@${target.targetVersion}`))];

  if (eveChanged && !(await approveEveChange(cwd, options.yes === true, Boolean(deps["@kybernesis/buzz"])))) {
    process.exitCode = 1;
    return;
  }

  repairLocalQueueTimeouts(cwd, deps);

  if (changed.length === 0) {
    console.log(`\n${green("Everything is at latest certified versions.")}\n`);
    repairBuzzSetup(cwd, deps);
    repairRemovedDefaultTools(cwd);
    repairSandboxCleanupHooks(cwd, deps);
    reportGithubToolsMountRepair(cwd);
    repairHostArtifacts(cwd, deps);
    repairEvalCommand(cwd);
    repairManageRestart(cwd, deps);
    return;
  }

  console.log(bold(`\nInstalling: ${changed.join(", ")}\n`));

  let stoppedBridge: string | null = null;
  if (cleanInstall && deps["@kybernesis/buzz"]) {
    const stopped = stopActiveBridge(cwd, buzzBridgeUnit(cwd));
    if (stopped === false) return;
    stoppedBridge = stopped;
  }

  if (cleanInstall) {
    rewriteManifest(cwd, pkg, targets);
    try {
      rmSync(join(cwd, "node_modules"), { recursive: true, force: true });
      rmSync(join(cwd, "package-lock.json"), { force: true });
    } catch (error) {
      fail(`Could not remove npm resolver state: ${(error as Error).message}`);
      recoveryGuidance(targets, stoppedBridge ?? undefined);
      return;
    }
  }

  // Outside a clean install, eve goes in with --save-exact for the same
  // reason rewriteManifest pins it: npm would save a caret by default.
  const eveChange = changed.find((spec) => spec.startsWith("eve@"));
  const others = changed.filter((spec) => spec !== eveChange);
  const installArgs = cleanInstall ? ["install"] : ["install", ...others];
  let installed = cleanInstall || others.length > 0 ? commandResult("npm", installArgs, cwd) : { status: 0, stdout: "", stderr: "" };
  if (installed.status === 0 && !cleanInstall && eveChange) {
    installed = commandResult("npm", ["install", "--save-exact", eveChange], cwd);
  }
  if (installed.status !== 0) {
    const output = `${installed.stdout}\n${installed.stderr}`;
    if (/ERESOLVE/i.test(output)) {
      console.log(red("\nnpm reported ERESOLVE while installing the planned dependency set."));
    } else {
      console.log(red("\nnpm install failed before the dependency tree could be verified."));
    }
    recoveryGuidance(targets, stoppedBridge ?? undefined);
    process.exitCode = 1;
    return;
  }

  const validation = commandResult("npm", ["ls", "eve"], cwd);
  if (validation.status !== 0) {
    fail("npm ls eve failed. The installed peer tree is not valid.");
    recoveryGuidance(targets, stoppedBridge ?? undefined);
    return;
  }

  if (stoppedBridge && !startStoppedBridge(cwd, stoppedBridge)) return;

  repairBuzzSetup(cwd, deps);
  repairRemovedDefaultTools(cwd);
  repairSandboxCleanupHooks(cwd, deps);
  reportGithubToolsMountRepair(cwd);
  repairHostArtifacts(cwd, deps);
  repairEvalCommand(cwd);
  repairManageRestart(cwd, deps);

  run("npm", ["run", "typecheck"], { cwd });
  if (eveChanged) {
    const infoOk = run("npx", ["eve", "info"], { cwd, allowFail: true, quiet: true });
    console.log(infoOk ? green("  ✓ eve discovery clean after framework upgrade") : red("  ✗ eve info failed after framework upgrade — inspect before going further"));
  }

  if (options.skipEval) {
    console.log(yellow("\nEval gate SKIPPED (--skip-eval). Run `npm run eval` before deploying.\n"));
    return;
  }

  await runUpgradeEvalGate(cwd, options.host);
}
