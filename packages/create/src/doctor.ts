import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { bold, capture, dim, green, parseEnv, red, yellow } from "./util.js";

type Verdict = "pass" | "warn" | "fail";
const MARK: Record<Verdict, string> = {
  pass: green("✓"),
  warn: yellow("!"),
  fail: red("✗"),
};

interface Check {
  verdict: Verdict;
  label: string;
  detail?: string;
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
  for (const p of ["@kybernesis/arcana", "@kybernesis/enterprise", "@kybernesis/multiplayer", "@kybernesis/evals"]) {
    if (deps[p]) add("pass", `${p} ${deps[p]}`);
    else add("warn", `${p} not installed`, `eve add @kybernesis/${p.split("/")[1]}`);
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

    // eve start does not read .env.local the way eve dev does.
    add(
      "warn",
      "self-hosted: export .env.local into the server process",
      "eve start does NOT read it; use the supervision script from @kybernesis/exe (scripts/eve-server.sh)",
    );

    // Prewarm runs in the eve CLI, not the built server.
    add(
      "warn",
      "self-hosted: start via `npx eve start`, not `node .output/server/index.mjs`",
      "sandbox templates are prewarmed by the CLI; starting the server directly skips prewarm and every sandbox tool fails with SandboxTemplateNotProvisionedError",
    );

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
    if (process.env.KYBERNESIS_AGENT_CREDENTIAL) {
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
    if (process.env.KYBERNESIS_AGENT) {
      add("pass", "management routes can resolve this agent's grants");
    } else {
      add(
        "fail",
        "management routes have no KYBERNESIS_AGENT",
        "KYBER Studio cannot install or write routines here: the agent cannot check a grant for a name it does not know",
      );
    }
    add(
      "warn",
      "management routes need a writable working copy",
      "installing edits this repo and rebuilds; on a read-only serverless bundle the routes refuse. Set restartCommand in agent/channels/kyb.ts or an install will not take effect",
    );
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
      add("pass", "engineer mounted locally on the subagent (root keeps no shell)");
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
  const info = capture("npx", ["eve", "info"], cwd);
  if (info === null) add("fail", "eve info failed", "run npx eve info for details");
  else {
    const diag = /Diagnostics\s+(\d+) errors?, (\d+) warnings?/.exec(info);
    if (diag && diag[1] === "0") add("pass", `eve discovery clean (${diag[2]} warnings)`);
    else add("fail", `eve discovery: ${diag ? `${diag[1]} errors` : "unparsed"}`, "npx eve info");
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
