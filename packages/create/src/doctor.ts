import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { pathToFileURL } from "node:url";
import { bold, capture, dim, green, parseEnv, red, yellow } from "./util.js";
import { diagnoseManageRestart, findMatchingAgentServiceUnit } from "./systemd.js";
import { formatSessionInputLimit, inspectEveManifest } from "./session-limit.js";

type Verdict = "pass" | "warn" | "fail";
const MARK: Record<Verdict, string> = {
  pass: green("✓"),
  warn: yellow("!"),
  fail: red("✗"),
};

export interface Check {
  verdict: Verdict;
  label: string;
  detail?: string;
}

/** The shape @kybernesis/exe's inspector returns; declared here so create keeps zero runtime deps. */
export interface DockerTemplateInspection {
  status: "skipped" | "present" | "failed";
  sandboxes: readonly string[];
  images: readonly string[];
  issues: readonly { kind: "missing-marker" | "missing-image" | "incomplete-set" | "docker-error"; subject: string; detail: string }[];
}

export function dockerTemplateDoctorChecks(result: DockerTemplateInspection): Check[] {
  if (result.status === "skipped") return [];
  if (result.status === "present") {
    return [{
      verdict: "pass",
      label: `Docker sandbox templates provisioned (${result.images.length}/${result.sandboxes.length})`,
    }];
  }
  return result.issues.map((issue) => ({
    // A set the newest build did not fully cover still serves: the uncovered
    // scope builds on first use. A current marker with no image, or a daemon
    // that will not answer, is a fault.
    verdict: issue.kind === "incomplete-set" ? "warn" : "fail",
    label: issue.kind === "missing-marker"
      ? `Docker sandbox template unresolved: ${issue.subject}`
      : issue.kind === "incomplete-set"
        ? `Docker sandbox templates incomplete: ${issue.subject}`
        : `Docker sandbox template unavailable: ${issue.subject}`,
    detail: issue.detail,
  }));
}

/**
 * The inspector lives in @kybernesis/exe, next to the runtime that owns the
 * templates; create already resolves that package's scripts out of
 * node_modules at runtime, and does the same here rather than carry a second
 * copy of a heuristic this subtle. No exe package means no Docker host, and
 * no check.
 */
export async function inspectDockerTemplatesViaExe(cwd: string): Promise<DockerTemplateInspection | null> {
  const module = join(cwd, "node_modules/@kybernesis/exe/dist/docker-templates.js");
  if (!existsSync(module)) return null;
  const { inspectDockerTemplates } = (await import(pathToFileURL(module).href)) as {
    inspectDockerTemplates: (options: { appDir: string }) => Promise<DockerTemplateInspection>;
  };
  return inspectDockerTemplates({ appDir: cwd });
}

async function head(url: string, headers?: Record<string, string>): Promise<number | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    return res.status;
  } catch {
    return null;
  }
}

export async function doctor(): Promise<void> {
  const cwd = process.cwd();
  const installedAgentService = findMatchingAgentServiceUnit(cwd);
  const checks: Check[] = [];
  const add = (verdict: Verdict, label: string, detail?: string) =>
    checks.push({ verdict, label, detail });

  // ── project shape ──────────────────────────────────────────────────────
  if (!existsSync(join(cwd, "agent"))) {
    console.error(red("Not an eve agent project (no agent/ directory). Run inside the agent repo."));
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  for (const p of ["@kybernesis/arcana", "@kybernesis/enterprise", "@kybernesis/evals"]) {
    if (deps[p]) add("pass", `${p} ${deps[p]}`);
    else add("warn", `${p} not installed`, `eve add @kybernesis/${p.split("/")[1]}`);
  }

  /**
   * multiplayer is conversation mechanics for a SHARED channel — threads with
   * per-speaker identity, the public/DM split. An agent reached only through
   * Studio or a direct API has no such channel, so telling its operator to
   * install it is advice that cannot be usefully acted on. A warning nobody can
   * clear is how a checklist stops being read.
   */
  const channelsDir = join(cwd, "agent", "channels");
  const sharedChannel =
    existsSync(channelsDir) && readdirSync(channelsDir).some((f) => /^(slack|discord|telegram)\./.test(f));
  if (deps["@kybernesis/multiplayer"]) {
    add("pass", `@kybernesis/multiplayer ${deps["@kybernesis/multiplayer"]}`);
  } else if (sharedChannel) {
    add(
      "warn",
      "@kybernesis/multiplayer not installed",
      "this agent has a shared channel, which needs its thread + per-speaker identity mechanics",
    );
  } else {
    add("pass", "no shared channel, so multiplayer is not needed");
  }

  // ── env ────────────────────────────────────────────────────────────────
  const envPath = join(cwd, ".env.local");
  const env: Record<string, string> = {
    ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}),
    ...(process.env as Record<string, string>),
  };
  if (!existsSync(envPath)) add("warn", ".env.local missing", "copy .env.example and fill it");

  // ── arcana keys: validate every key↔workspace pair read-only ───────────
  const arcanaPairs: Array<{ key: string; ws: string; label: string }> = [];
  if (env.ARCANA_API_KEY && env.ARCANA_COMPANY_WORKSPACE)
    arcanaPairs.push({ key: env.ARCANA_API_KEY, ws: env.ARCANA_COMPANY_WORKSPACE, label: "company brain" });
  if (env.ARCANA_EVAL_API_KEY) {
    // Match both `WORKSPACE=name-eval` and the shell-default form
    // `WORKSPACE=${ARCANA_EVAL_WORKSPACE:-name-eval}`.
    const script = pkg.scripts?.eval ?? "";
    const evalWs =
      /=\$\{[A-Z0-9_]+:-([a-z0-9][a-z0-9-]*-eval)\}/.exec(script) ??
      /=([a-z0-9][a-z0-9-]*-eval)\b/.exec(script);
    if (evalWs?.[1]) arcanaPairs.push({ key: env.ARCANA_EVAL_API_KEY, ws: evalWs[1], label: "eval workspace" });
  }
  for (const [k, v] of Object.entries(env)) {
    const m = /^ARCANA_([A-Z0-9_]+)_API_KEY$/.exec(k);
    if (m && m[1] !== "EVAL" && v) {
      const ws = env[`ARCANA_${m[1]}_WORKSPACE`];
      if (ws) arcanaPairs.push({ key: v, ws, label: `${m[1].toLowerCase()} brain` });
    }
  }
  if (arcanaPairs.length === 0) add("warn", "no Arcana key+workspace pairs configured");
  for (const pair of arcanaPairs) {
    const status = await head(
      `https://api.arcana.kybernesis.ai/brain/${pair.ws}/timeline?limit=1`,
      { Authorization: `Bearer ${pair.key}`, "X-Kyberagent-Agent": pair.ws },
    );
    if (status === 200) add("pass", `Arcana ${pair.label} (${pair.ws})`);
    else if (status === 403) add("fail", `Arcana ${pair.label}: key not scoped to "${pair.ws}"`, "wrong key for this workspace");
    else if (status === 404) add("fail", `Arcana ${pair.label}: workspace "${pair.ws}" does not exist`, "create it in Arcana");
    else add("fail", `Arcana ${pair.label} (${pair.ws}): HTTP ${status ?? "unreachable"}`);
  }

  // ── control plane ──────────────────────────────────────────────────────
  if (env.KYBERNESIS_ISSUER) {
    const status = await head(`${env.KYBERNESIS_ISSUER.replace(/\/$/, "")}/api/jwks`);
    if (status === 200) add("pass", `issuer JWKS reachable (${env.KYBERNESIS_ISSUER})`);
    else add("fail", `issuer JWKS: HTTP ${status ?? "unreachable"} (${env.KYBERNESIS_ISSUER})`);
    if (!env.KYBERNESIS_AGENT) add("fail", "KYBERNESIS_AGENT not set", "must equal the control-plane agent name");
    else add("pass", `governed as "${env.KYBERNESIS_AGENT}"`, "confirm it's registered + granted in the admin");
  } else {
    add("warn", "KYBERNESIS_ISSUER not set", "agent is not control-plane governed");
  }

  // ── slack ──────────────────────────────────────────────────────────────
  // Only relevant when the agent actually has a Slack channel — a client on
  // iMessage or Telegram should never be told to create a Slack connector.
  const hasSlackChannel = existsSync(join(cwd, "agent/channels/slack.ts"));
  if (hasSlackChannel) {
    if (env.SLACK_CONNECTOR_UID) add("pass", `Slack connector uid: ${env.SLACK_CONNECTOR_UID}`, "verify trigger path /eve/v1/slack (vercel connect list)");
    else if (env.SLACK_BOT_TOKEN) add("pass", "Slack via portable credentials (SLACK_BOT_TOKEN)");
    else add("warn", "Slack channel present but no credentials", "SLACK_CONNECTOR_UID (Vercel) or SLACK_BOT_TOKEN (portable)");
  }

  // ── engineer layer (optional — checked only when installed) ────────────
  const hasEngineer = Boolean(deps["@kybernesis/engineer"]) || existsSync(join(cwd, "agent/extensions/engineer.ts"));
  if (hasEngineer) {
    add("pass", `@kybernesis/engineer ${deps["@kybernesis/engineer"] ?? "(extension file present)"}`);
    // The workshop may sit on the root OR on the engineer subagent (the
    // scoped pattern). Either is valid; neither is not.
    const rootSandbox = existsSync(join(cwd, "agent/sandbox/sandbox.ts"));
    const builderSandbox = existsSync(join(cwd, "agent/subagents/builder/sandbox/sandbox.ts"));
    if (rootSandbox || builderSandbox) {
      add("pass", `workshop sandbox present (${builderSandbox ? "engineer subagent" : "root agent"})`);
    } else {
      add("fail", "no workshop sandbox", "the engineer layer needs one — on the root or on agent/subagents/builder/");
    }
    const vercelConn = join(cwd, "agent/connections/vercel.ts");
    const selfHostedAgent =
      Boolean(deps["@kybernesis/exe"]) ||
      (existsSync(join(cwd, "agent/subagents/builder/sandbox/sandbox.ts")) &&
        readFileSync(join(cwd, "agent/subagents/builder/sandbox/sandbox.ts"), "utf8").includes("docker("));
    if (selfHostedAgent && !existsSync(vercelConn)) {
      add(
        "pass",
        "no Vercel MCP connection (self-hosted)",
        "public deploys need the CLIENT's own Vercel token — Vercel Connect does not work off-Vercel",
      );
    } else if (existsSync(vercelConn)) {
      const src = readFileSync(vercelConn, "utf8");
      const uid = /connect\(\s*"([^"]+)"/.exec(src)?.[1];
      if (uid && uid.includes("/")) add("pass", `vercel connection uses connector UID (${uid})`, "verify attached: vercel connect list");
      else add("fail", `vercel connection uses "${uid ?? "?"}" — must be the connector UID`, 'e.g. connect("mcp.vercel.com/vercel")');
    } else {
      add("warn", "agent/connections/vercel.ts missing — no preview deploys/link-back", "eve add connection/vercel, then vercel connect create + attach");
    }
    if (!selfHostedAgent) {
      if (env.VERCEL_OIDC_TOKEN || env.VERCEL_TOKEN) add("pass", "Vercel credentials for local hosted sandboxes");
      else add("warn", "no VERCEL_OIDC_TOKEN — local sandbox/eval runs cannot reach Vercel Sandbox", "vercel link && vercel env pull");
    }
  }

  // ── dispatch edges (agent-to-agent — checked only when present) ────────
  const subagentsDir = join(cwd, "agent/subagents");
  const edgeFiles: string[] = [];
  if (existsSync(subagentsDir)) {
    for (const entry of readdirSync(subagentsDir)) {
      const flat = join(subagentsDir, entry);
      const nested = join(subagentsDir, entry, "agent.ts");
      const path = entry.endsWith(".ts") ? flat : existsSync(nested) ? nested : null;
      if (!path) continue;
      const src = readFileSync(path, "utf8");
      if (src.includes("remotePeer") || src.includes("defineRemoteAgent")) edgeFiles.push(path);
    }
  }
  const eveChannelPath = join(cwd, "agent/channels/eve.ts");
  const eveChannelSrc = existsSync(eveChannelPath) ? readFileSync(eveChannelPath, "utf8") : null;
  const hasDispatch = Boolean(deps["@kybernesis/dispatch"]) || edgeFiles.length > 0 ||
    Boolean(eveChannelSrc && (eveChannelSrc.includes("dispatchChannel") || eveChannelSrc.includes("trustedForwarders")));
  if (hasDispatch) {
    for (const path of edgeFiles) {
      const src = readFileSync(path, "utf8");
      const name = path.split("/agent/subagents/")[1];
      const envVar = /envVar:\s*"([A-Z0-9_]+)"/.exec(src)?.[1] ?? /process\.env\.([A-Z0-9_]+)/.exec(src)?.[1];
      if (!envVar) add("warn", `dispatch edge ${name}: no env-var URL found`, "use remotePeer({ envVar }) so the target is repointable");
      else if (env[envVar]) add("pass", `dispatch edge ${name} → $${envVar} set locally`, "confirm it's also set on the Vercel project");
      else add("warn", `dispatch edge ${name}: $${envVar} unset locally`, `printf "<peer-url>" | vercel env add ${envVar} production (and vercel env pull)`);
      if (src.includes("defineRemoteAgent") && !src.includes("forwardPrincipal"))
        add("warn", `dispatch edge ${name}: forwardPrincipal not set`, "peer will see this app's service identity, not the human — use remotePeer() for the safe defaults");
    }
    if (edgeFiles.length > 0)
      add("warn", "dispatch: verify BOTH ends run compatible eve versions", "an old receiver silently drops forwardPrincipal (runs as service identity)");
    if (eveChannelSrc) {
      if (/trustedForwarders:\s*(\(\s*\)|\([^)]*\))\s*=>\s*true/.test(eveChannelSrc))
        add("fail", "eve channel: trustedForwarders is () => true", "any authenticated caller can assert any identity — enumerate peers (dispatchChannel)");
      else if (eveChannelSrc.includes("dispatchChannel") || eveChannelSrc.includes("trustedForwarders"))
        add("pass", "eve channel accepts forwarded principals from enumerated peers only");
    } else if (Boolean(deps["@kybernesis/dispatch"]) && edgeFiles.length === 0) {
      add("warn", "@kybernesis/dispatch installed but no edges or dispatch channel found", "see the connect-agents skill");
    }
  }

  // ── self-hosted agents (host !== Vercel) ───────────────────────────────
  // Every check here cost a real debugging session on the first exe.dev
  // deployment. None of them are theoretical.
  const selfHosted =
    Boolean(deps["@kybernesis/exe"]) ||
    existsSync(join(cwd, "agent/sandbox/sandbox.ts")) &&
      readFileSync(join(cwd, "agent/sandbox/sandbox.ts"), "utf8").includes("docker(");
  const templateInspection = await inspectDockerTemplatesViaExe(cwd);
  for (const check of templateInspection ? dockerTemplateDoctorChecks(templateInspection) : []) {
    add(check.verdict, check.label, check.detail);
  }

  if (selfHosted) {
    // Vercel Connect needs Vercel OIDC — it CANNOT work off-Vercel, for Slack,
    // the Vercel MCP connection, or anything else. Every such connection has to
    // become a static credential the client issues.
    const connectUsers: string[] = [];
    for (const dir of ["agent/channels", "agent/connections"]) {
      const full = join(cwd, dir);
      if (!existsSync(full)) continue;
      for (const f of readdirSync(full)) {
        const file = join(full, f);
        if (!f.endsWith(".ts")) continue;
        if (readFileSync(file, "utf8").includes("@vercel/connect")) connectUsers.push(`${dir}/${f}`);
      }
    }
    if (connectUsers.length) {
      add(
        "fail",
        `Vercel Connect used off-Vercel: ${connectUsers.join(", ")}`,
        "Connect authenticates via Vercel OIDC, which does not exist on this host — the agent will fail to boot. Switch to portable/static credentials",
      );
    } else {
      add("pass", "no Vercel Connect dependencies (correct for a self-hosted agent)");
    }

    /**
     * Both of the next two are real ways a self-hosted agent boots broken:
     * `eve start` does not read .env.local the way `eve dev` does, and sandbox
     * templates are prewarmed by the CLI, so launching the built server
     * directly fails every sandbox tool with SandboxTemplateNotProvisionedError.
     *
     * The supervision script does both correctly. When it is present, saying so
     * is the useful report — repeating the hazard as a warning teaches the
     * operator that warnings here are decoration.
     */
    const supervisor = join(cwd, "scripts/eve-server.sh");
    if (installedAgentService) {
      if (installedAgentService.contents.includes(
        "ExecStartPre=/bin/bash -lc 'set -a && . ./.env.local && set +a && npx eve build'",
      )) {
        add("pass", `systemd ${installedAgentService.values.name}-agent builds before every start`);
      } else {
        add(
          "fail",
          `systemd ${installedAgentService.values.name}-agent has no build-before-start gate`,
          "run kyb upgrade to refresh an unchanged package unit; if customized, move overrides to `sudo systemctl edit " +
            `${installedAgentService.values.name}-agent` +
            "` and follow the exact repair command it prints",
        );
      }
    } else if (existsSync(supervisor)) {
      add("pass", "scripts/eve-server.sh present (exports .env.local, builds if stale, starts via the eve CLI)");
    } else {
      add(
        "warn",
        "self-hosted: export .env.local into the server process",
        "eve start does NOT read it; install systemd with node_modules/@kybernesis/exe/scripts/install-service.sh",
      );
      add(
        "warn",
        "self-hosted: start via `npx eve start`, not `node .output/server/index.mjs`",
        "sandbox templates are prewarmed by the CLI; starting the server directly skips prewarm and every sandbox tool fails with SandboxTemplateNotProvisionedError",
      );
    }

    /**
     * A self-hosted agent answering everything twice.
     *
     * The local queue delivers a turn by POSTing it to this same server and
     * holds that connection open for the whole turn, but its client gives up
     * after 30 seconds by default. Every turn slower than that is redelivered,
     * and the workflow re-executes steps that already ran — so the person gets
     * two differently-worded answers to one question, and the log says only
     * that a retry recovered. It is reported as the model being odd, which
     * sends the search nowhere near the transport.
     *
     * Hosted agents never see it; real queue infrastructure runs there. This is
     * a cost of self-hosting that nothing in the environment announces.
     */
    const QUEUE_TIMEOUT_FLOOR_MS = 120_000;
    const shortQueueTimeouts = [
      "WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS",
      "WORKFLOW_LOCAL_BODY_TIMEOUT_MS",
    ].filter((name) => Number(env[name] ?? 30_000) < QUEUE_TIMEOUT_FLOOR_MS);
    if (shortQueueTimeouts.length === 0) {
      add("pass", "local queue delivery survives turns longer than 30s");
    } else {
      add(
        "fail",
        `self-hosted: ${shortQueueTimeouts.join(" and ")} left at the 30s default`,
        "one queue delivery holds a connection open for the entire turn, so any turn slower than the timeout is redelivered and its steps re-run — the agent answers the same question twice, with two different answers, and nothing reports an error. Set both to 900000 in .env.local and restart the server",
      );
    }

    /**
     * Disk, on a host whose runtime does not clean up after itself.
     *
     * eve builds a sandbox template per session configuration and keeps every
     * one, and leaves session containers running long after their turn ended.
     * The result is gigabytes a day on a working agent, and the failure it
     * eventually produces looks like anything except a full disk.
     */
    if (capture("sh", ["-c", "command -v docker >/dev/null && echo yes"])?.trim() === "yes") {
      const job = capture("sh", ["-c", "test -x /etc/cron.daily/kyb-docker-prune && echo yes"])?.trim();
      const percent = Number(capture("sh", ["-c", "df / | awk 'NR==2{print $5}' | tr -d '%'"])?.trim() ?? 0);
      if (job !== "yes") {
        add(
          "warn",
          "no daily docker reclaim on this host",
          "sandbox templates, build cache, and generic stopped containers accumulate; durable sessions stay protected and terminal hooks remove closed sessions; `kyb upgrade` installs /etc/cron.daily/kyb-docker-prune",
        );
      } else if (percent >= 80) {
        add(
          "fail",
          `disk ${percent}% full despite the reclaim job`,
          "run it now: sudo /etc/cron.daily/kyb-docker-prune, and check what else is on this host",
        );
      } else {
        add("pass", `daily docker reclaim installed (disk ${percent}% used)`);
      }
    }

    /**
     * Instructions that name a tool the agent does not have.
     *
     * `deliver` mounts with the engineer layer, which is mounted on the builder
     * subagent — so an agent whose ROOT is told to hand over files (by its own
     * instructions, or by our playbook, which says to) promises a file it
     * cannot send. It cannot see the mismatch either: it writes the contents to
     * a memory note, or apologises without a cause, and the delivery
     * infrastructure passes every check while nobody can receive anything.
     */
    const rootDeliver = existsSync(join(cwd, "agent/tools/deliver.ts"));
    const instructionsMentionDeliver = (() => {
      try {
        const dir = join(cwd, "agent/instructions");
        return readdirSync(dir).some((file) =>
          readFileSync(join(dir, file), "utf8").includes("deliver"),
        );
      } catch {
        return false;
      }
    })();
    if (instructionsMentionDeliver && !rootDeliver) {
      add(
        "fail",
        "instructions tell this agent to deliver files, but the root has no deliver tool",
        'add agent/tools/deliver.ts: export { deliver as default } from "@kybernesis/engineer/tools" — the engineer layer mounts it on the builder subagent only',
      );
    } else if (rootDeliver) {
      add("pass", "the agent that talks to people can also hand them a file");
    }

    // The exe VM sandbox backend needs a credential that cannot be scoped.
    // Surface the blast radius here, where it is still cheap to change course.
    const sandboxFile = join(cwd, "agent/sandbox/sandbox.ts");
    const usesExeSandbox =
      existsSync(sandboxFile) && readFileSync(sandboxFile, "utf8").includes("exeSandbox(");
    if (usesExeSandbox) {
      const src = readFileSync(sandboxFile, "utf8");
      if (src.includes("allowSharedAccount: true")) {
        add(
          "warn",
          "exeSandbox runs with allowSharedAccount: true",
          "the sandbox SSH key grants shell to EVERY VM on the exe.dev account — only keep this if the client has explicitly accepted that blast radius; otherwise give the agent its own account",
        );
      } else {
        add("pass", "exeSandbox enforces a dedicated exe.dev account");
      }
      if (!process.env.EXE_SANDBOX_SSH_KEY && !process.env.EXE_SANDBOX_SSH_KEY_PATH) {
        add(
          "fail",
          "exeSandbox has no SSH key (EXE_SANDBOX_SSH_KEY / EXE_SANDBOX_SSH_KEY_PATH)",
          "it must be a FULL-PERMISSION account key: a key registered through an API token inherits that token's command scope and cannot open a shell at all",
        );
      }
      if (!process.env.EXE_API_TOKEN) {
        add(
          "fail",
          "exeSandbox has no EXE_API_TOKEN for VM lifecycle",
          "mint a narrow one: ssh exe.dev \"ssh-key generate-api-key --label=<agent>-sandbox --cmds='ls,new,rm,cp' --exp=7d\"",
        );
      }
    }
  }

  // ── KYBER Studio wiring ────────────────────────────────────────────────
  const hasLocal = existsSync(join(cwd, "agent/tools/local_shell.ts"));
  const hasManage = existsSync(join(cwd, "agent/channels/kyb.ts"));

  if (hasLocal) {
    // Without a credential the tools compile, appear in the tool list, and fail
    // at the moment the user asks for something — the worst time to learn a
    // deployment is incomplete. This is NOT a value to go and set by hand: the
    // switch in Studio installs it, and a missing one means nobody has turned
    // local access on yet.
    // `env`, not `process.env`: every other check reads the merged view, and
    // reading the bare environment here reported a missing credential on an
    // agent whose .env.local had one two lines above. A preflight tool that
    // cries wolf is a preflight tool people learn to skip.
    if (env.KYBERNESIS_AGENT_CREDENTIAL) {
      add("pass", "local execution can identify this agent to the control plane");
    } else {
      add(
        "warn",
        "local execution is installed but this agent has no credential yet",
        "turn on 'Work on this computer' in the agent's settings in KYBER Studio — it mints and installs one; do not paste a credential by hand",
      );
    }
  }

  if (hasManage) {
    // manage authorizes with the caller's control-plane grant, so it needs to
    // know which agent it IS before it can check one.
    if (env.KYBERNESIS_AGENT) {
      add("pass", "management routes can resolve this agent's grants");
    } else {
      add(
        "fail",
        "management routes have no KYBERNESIS_AGENT",
        "KYBER Studio cannot install or write routines here: the agent cannot check a grant for a name it does not know",
      );
    }
    // Installing edits the repo and rebuilds, so it only takes effect where a
    // restart can be triggered. With restartCommand set, that is answered; the
    // remaining requirement (a writable working copy) is a property of the
    // host, and on a read-only bundle the routes refuse with that reason.
    const manageFile = join(cwd, "agent/channels/kyb.ts");
    const manageSource = existsSync(manageFile) ? readFileSync(manageFile, "utf8") : "";
    const restartCommand = /\brestartCommand\s*:\s*["'`]([^"'`]+)["'`]/m.exec(manageSource)?.[1];
    const diagnosis = diagnoseManageRestart(
      installedAgentService?.values.name ?? null,
      restartCommand,
    );
    add(diagnosis.verdict, diagnosis.label, diagnosis.detail);
  }

  // ── engineer subagent (build capability scoped to a subagent) ──────────
  const builderDir = join(cwd, "agent/subagents/builder");
  if (existsSync(builderDir)) {
    // Subagents own their sandbox — they do NOT inherit the root's. Without one
    // the builder gets a bare template and every screenshot fails with
    // "Cannot find module 'playwright'" while the root's template is fine.
    if (existsSync(join(builderDir, "sandbox/sandbox.ts"))) {
      add("pass", "engineer subagent has its own workshop sandbox");
    } else {
      add(
        "fail",
        "engineer subagent has NO sandbox of its own",
        "subagents do not inherit the root sandbox — add agent/subagents/builder/sandbox/sandbox.ts or the vision loop cannot run",
      );
    }
    if (existsSync(join(builderDir, "extensions/engineer.ts"))) {
      // Not "the root keeps no shell": every eve agent has a sandbox with bash,
      // read_file, write_file, glob and grep. What the local mount withholds is
      // the build loop and any shell ON THE HOST. This sentence is one people
      // reason about security boundaries from, so it says the true thing.
      add("pass", "engineer mounted locally on the subagent (root gets no host shell, no build loop)");
    } else {
      add("warn", "engineer extension not mounted on the subagent", "agent/subagents/builder/extensions/engineer.ts");
    }
    // Delivery: either storage works, or the agent cannot hand over artifacts.
    if (env.BLOB_READ_WRITE_TOKEN) {
      add("pass", "file delivery via Vercel Blob");
    } else if (env.DELIVER_DIR && env.DELIVER_BASE_URL) {
      add("pass", `file delivery via host directory (${env.DELIVER_DIR})`);
    } else {
      add(
        "warn",
        "file delivery not configured — the agent cannot hand over artifacts",
        "set BLOB_READ_WRITE_TOKEN (the CLIENT's blob store) or DELIVER_DIR + DELIVER_BASE_URL",
      );
    }
  }

  // ── eve discovery + local port ─────────────────────────────────────────
  /**
   * Discovery, run with the environment the SERVER runs with.
   *
   * `eve info` compiles the agent, and an agent that reads a variable at module
   * scope — a model id, a required credential — throws without it. eve does not
   * load .env.local itself, so running this with a bare environment reported a
   * healthy agent as a failed discovery, on a host where the service starts it
   * correctly every time. That red is the one thing a person is told must be
   * green before going further, so it stopped a deployment that was fine.
   *
   * `env` here is the same merged view every other check reads: .env.local
   * underneath, the real environment on top.
   */
  const info = inspectEveManifest(cwd, env);
  if (info === null) {
    add(
      "fail",
      "eve info failed",
      "run: set -a && . ./.env.local && set +a && npx eve info --json — the agent's own error is in that output",
    );
    add("warn", "limits.maxInputTokensPerSession unverifiable", "eve discovery did not complete");
  } else {
    const diag = info.diagnostics;
    if (diag?.errors === 0) add("pass", `eve discovery clean (${diag.warnings} warnings)`);
    else add("fail", `eve discovery: ${diag ? `${diag.errors} errors` : "unparsed"}`, "npx eve info --json");
    add(
      info.limit.status === "unverifiable" ? "warn" : "pass",
      formatSessionInputLimit(info.limit),
    );
  }
  const portBusy = capture("lsof", ["-ti", ":2000"]);
  if (portBusy && portBusy.trim()) add("warn", "port 2000 in use", "eve eval exits early while a dev server runs — kill it first");
  else add("pass", "port 2000 free (eve eval can boot its own server)");

  // ── report ─────────────────────────────────────────────────────────────
  console.log(bold("\nkyb doctor\n"));
  for (const c of checks) {
    console.log(`  ${MARK[c.verdict]} ${c.label}${c.detail ? dim(`  — ${c.detail}`) : ""}`);
  }
  const fails = checks.filter((c) => c.verdict === "fail").length;
  const warns = checks.filter((c) => c.verdict === "warn").length;
  console.log(`\n  ${fails ? red(`${fails} failing`) : green("0 failing")}, ${warns ? yellow(`${warns} warnings`) : "0 warnings"}\n`);
  process.exit(fails ? 1 : 0);
}
