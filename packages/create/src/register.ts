import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bold, dim, green, red, yellow } from "./util.js";

/**
 * `kyb register` — register this agent with the control plane.
 *
 * Every other step of standing an agent up is a command; this one was a form in
 * a browser, which meant the one governance-relevant act in the sequence was
 * also the least repeatable. It signs in the same way the desktop app does —
 * RFC 8628 device flow — so nothing needs an admin session or a pasted token.
 */

interface Env {
  [k: string]: string;
}

function envOf(dir: string): Env {
  const out: Env = {};
  for (const file of [".env.local", ".env"]) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m?.[1] && out[m[1]] === undefined) out[m[1]] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** Sign in with the device flow and return an identity token. */
export async function signIn(issuer: string): Promise<string | null> {
  const started = await fetch(`${issuer}/api/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: `kyb-cli-${process.pid}`, deviceLabel: "kyb CLI" }),
  }).catch(() => null);
  if (!started?.ok) {
    console.log(red(`  Could not start sign-in at ${issuer}.`));
    return null;
  }
  const body = (await started.json()) as Record<string, unknown>;
  const url = String(body.verification_uri_complete ?? body.verification_uri ?? "");
  const code = String(body.user_code ?? "");
  const deviceCode = String(body.device_code ?? "");
  let interval = Number(body.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(body.expires_in ?? 600) * 1000;

  console.log(`\n  Approve this in your browser:\n`);
  console.log(`    ${bold(url)}`);
  if (code) console.log(`    code: ${bold(code)}\n`);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await fetch(`${issuer}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    }).catch(() => null);
    if (!res) continue;
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof out.token === "string") return out.token;
    if (out.error === "slow_down") interval += 5000;
    // authorization_pending is the normal case; anything else is fatal.
    if (out.error && out.error !== "authorization_pending" && out.error !== "slow_down") {
      console.log(red(`  Sign-in failed: ${String(out.error)}`));
      return null;
    }
  }
  console.log(red("  Sign-in timed out."));
  return null;
}

export async function register(options: { name?: string; url?: string; dir?: string }): Promise<void> {
  const dir = options.dir ?? process.cwd();
  const env = envOf(dir);
  const issuer = (env.KYBERNESIS_ISSUER || "https://agent.kybernesis.ai").replace(/\/$/, "");

  // The registered name must equal KYBERNESIS_AGENT exactly — it is what the
  // agent checks grants against, and a mismatch is a 403 with no clue in it.
  const name = options.name ?? env.KYBERNESIS_AGENT;
  const url =
    options.url ??
    env.EVE_PUBLIC_URL ??
    (env.EXE_VM_NAME ? `https://${env.EXE_VM_NAME}.exe.xyz` : undefined);

  console.log(bold("kyb register"));
  console.log(dim(`  issuer: ${issuer}`));

  if (!name) {
    console.log(red("  No agent name. Set KYBERNESIS_AGENT in .env.local, or pass --name=<name>."));
    process.exitCode = 1;
    return;
  }
  if (!url) {
    console.log(red("  No deployment URL. Set EXE_VM_NAME in .env.local, or pass --url=<https://…>."));
    process.exitCode = 1;
    return;
  }
  console.log(dim(`  agent:  ${name}\n  url:    ${url}`));

  const token = await signIn(issuer);
  if (!token) {
    process.exitCode = 1;
    return;
  }

  const res = await fetch(`${issuer}/api/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, url }),
  }).catch(() => null);

  if (!res?.ok) {
    const detail = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : "unreachable";
    console.log(red(`\n  Registration failed: ${detail ?? res?.status}`));
    process.exitCode = 1;
    return;
  }

  const out = (await res.json()) as { created?: boolean };
  console.log(
    green(
      out.created
        ? `\n  ✓ registered "${name}" and granted you access`
        : `\n  ✓ "${name}" already existed — its URL now points at ${url}`,
    ),
  );
  console.log(dim("    Grant others in the admin; they do not inherit yours."));
  if (!env.KYBERNESIS_AGENT_CREDENTIAL) {
    console.log(
      yellow(
        "\n  ! This agent has no credential yet. Turn on 'Work on this computer' in\n" +
          "    KYBER Studio to mint and install one — do not paste a credential by hand.",
      ),
    );
  }
}
