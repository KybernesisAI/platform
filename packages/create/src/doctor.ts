import { existsSync, readFileSync } from "node:fs";
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
    const evalWs = /ARCANA_COMPANY_WORKSPACE=([a-z0-9-]+)-eval|([a-z0-9-]+)-eval/.exec(pkg.scripts?.eval ?? "");
    const ws = evalWs?.[1] ? `${evalWs[1]}-eval` : evalWs?.[2] ? `${evalWs[2]}-eval` : null;
    if (ws) arcanaPairs.push({ key: env.ARCANA_EVAL_API_KEY, ws, label: "eval workspace" });
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
  if (env.SLACK_CONNECTOR_UID) add("pass", `Slack connector uid: ${env.SLACK_CONNECTOR_UID}`, "verify trigger path /eve/v1/slack (vercel connect list)");
  else add("warn", "SLACK_CONNECTOR_UID not set", "vercel connect create slack --triggers");

  // ── engineer layer (optional — checked only when installed) ────────────
  const hasEngineer = Boolean(deps["@kybernesis/engineer"]) || existsSync(join(cwd, "agent/extensions/engineer.ts"));
  if (hasEngineer) {
    add("pass", `@kybernesis/engineer ${deps["@kybernesis/engineer"] ?? "(extension file present)"}`);
    if (existsSync(join(cwd, "agent/sandbox/sandbox.ts"))) add("pass", "workshop sandbox file present");
    else add("fail", "agent/sandbox/sandbox.ts missing", "eve add @kybernesis/engineer --overwrite writes it");
    if (env.BLOB_READ_WRITE_TOKEN) add("pass", "file delivery configured (BLOB_READ_WRITE_TOKEN)");
    else add("warn", "BLOB_READ_WRITE_TOKEN not set — deliver tool will fail", "vercel blob create-store <name>-deliverables --access public --yes");
    const vercelConn = join(cwd, "agent/connections/vercel.ts");
    if (existsSync(vercelConn)) {
      const src = readFileSync(vercelConn, "utf8");
      const uid = /connect\(\s*"([^"]+)"/.exec(src)?.[1];
      if (uid && uid.includes("/")) add("pass", `vercel connection uses connector UID (${uid})`, "verify attached: vercel connect list");
      else add("fail", `vercel connection uses "${uid ?? "?"}" — must be the connector UID`, 'e.g. connect("mcp.vercel.com/vercel")');
    } else {
      add("warn", "agent/connections/vercel.ts missing — no preview deploys/link-back", "eve add connection/vercel, then vercel connect create + attach");
    }
    if (env.VERCEL_OIDC_TOKEN || env.VERCEL_TOKEN) add("pass", "Vercel credentials for local hosted sandboxes");
    else add("warn", "no VERCEL_OIDC_TOKEN — local sandbox/eval runs cannot reach Vercel Sandbox", "vercel link && vercel env pull");
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
