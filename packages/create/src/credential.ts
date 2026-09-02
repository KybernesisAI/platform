import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { upsertEnv } from "./envfile.js";
import { systemdRestartCommand } from "./systemd.js";
import { signIn } from "./register.js";
import { bold, dim, green, red, yellow } from "./util.js";

/**
 * `kyb credential` — mint this agent's control-plane credential and install it
 * on its host.
 *
 * The credential is what an agent uses to prove it is itself: it is required to
 * discover granted peers and to mint the short-lived tokens that reach them.
 * Without one, `governedPeers()` finds nothing and says nothing — no tools, no
 * error, an agent that simply never mentions the colleague you granted it.
 *
 * Until now the only way to install one was KYBER Studio's "Work on this
 * computer" toggle. That is a good path and stays the default, but it is a
 * desktop app doing something the CLI can do: sign in as the owner, mint, and
 * write it where the agent reads it. Making a headless setup depend on a GUI
 * toggle is the kind of gap that turns a ten-minute deployment into an evening.
 *
 * The value is never printed and never passed through a shell argument — it
 * goes to the host over stdin and lands in a 0600 file.
 */

function envOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const p = join(dir, ".env.local");
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m?.[1] && out[m[1]] === undefined) out[m[1]] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Is this machine the SSH target we were about to dial?
 *
 * Compared on the short name as well as the full one, because a host that
 * answers to `box.example.xyz` usually reports itself as `box` — and the env
 * file names whichever the person happened to type.
 */
function isThisHost(target: string): boolean {
  const self = hostname().toLowerCase();
  const short = self.split(".")[0] ?? self;
  const wanted = target.toLowerCase();
  return wanted === self || wanted === short || wanted.split(".")[0] === short;
}

export async function credential(options: {
  dir?: string;
  name?: string;
  host?: string;
  local?: boolean;
}): Promise<void> {
  const dir = options.dir ?? process.cwd();
  const env = envOf(dir);
  const issuer = (env.KYBERNESIS_ISSUER || "https://agent.kybernesis.ai").replace(/\/$/, "");
  const agent = options.name ?? env.KYBERNESIS_AGENT;

  console.log(bold("kyb credential"));
  if (!agent) {
    console.log(red("  No agent name. Set KYBERNESIS_AGENT in .env.local, or pass --name=<name>."));
    process.exitCode = 1;
    return;
  }
  console.log(dim(`  agent: ${agent}   issuer: ${issuer}`));

  const token = await signIn(issuer);
  if (!token) {
    process.exitCode = 1;
    return;
  }

  const res = await fetch(`${issuer}/api/agents/credential`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent }),
  }).catch(() => null);

  if (!res?.ok) {
    const detail = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string };
    console.log(red(`\n  Could not mint a credential (${res?.status ?? "no response"}).`));
    if (detail.error === 'unknown agent') {
      console.log(dim(`  No agent named "${agent}" in your org — register it first with \`kyb register\`.`));
    } else if (res?.status === 403) {
      // Deliberately not the same as "may talk to it": holding the credential
      // means BEING the agent, so only an owner or manage grant qualifies.
      console.log(dim("  You need to own this agent, or hold a manage grant on it."));
    } else if (detail.error) {
      console.log(dim(`  ${detail.error}`));
    }
    process.exitCode = 1;
    return;
  }

  const minted = (await res.json()) as { credential?: string; token?: string };
  const value = minted.credential ?? minted.token;
  if (!value) {
    console.log(red("  The control plane returned no credential."));
    process.exitCode = 1;
    return;
  }

  // Where the agent will read it from. A deployed agent reads the HOST's copy;
  // writing only the laptop's is the mistake that makes this look done and
  // leaves discovery silent, because `kyb deploy` deliberately never overwrites
  // a host .env.local that already exists.
  const target = options.host ?? env.EVE_SSH_HOST ?? (env.EXE_VM_NAME ? `${env.EXE_VM_NAME}.exe.xyz` : null);

  // Already ON the host it would otherwise SSH to.
  //
  // Naming a host is how a laptop installs the credential where the agent will
  // read it. Run the same command on that host — the natural thing to do while
  // setting one up over SSH — and it dialled itself, needed a key the host does
  // not hold for itself, and failed at the last step of an otherwise complete
  // sign-in. The file it wanted to write was already under the cursor.
  const onTargetHost = target !== null && isThisHost(target);

  if (options.local || !target || onTargetHost) {
    upsertEnv(dir, { KYBERNESIS_AGENT_CREDENTIAL: value });
    console.log(green("\n  ✓ credential written to ./.env.local"));
    if (onTargetHost) console.log(dim(`  This IS ${target}, so there was nothing to copy.`));
    if (!target) console.log(dim("  No host known — deploy it, or re-run with --host=<ssh target>."));
    return;
  }

  const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name ?? "agent";
  const remote = `~/${name}/.env.local`;
  // stdin, never argv: a credential in a command line is visible in the host's
  // process list and lands in shell history on both machines.
  const script =
    `set -e; f="${remote}"; f="\${f/#\\~/$HOME}"; v=$(cat); touch "$f"; chmod 600 "$f"; ` +
    `tmp=$(mktemp); grep -v '^KYBERNESIS_AGENT_CREDENTIAL=' "$f" > "$tmp" || true; ` +
    `printf 'KYBERNESIS_AGENT_CREDENTIAL="%s"\\n' "$v" >> "$tmp"; mv "$tmp" "$f"; chmod 600 "$f"; ` +
    `grep -c '^KYBERNESIS_AGENT_CREDENTIAL=' "$f"`;

  try {
    const wrote = execFileSync("ssh", [target, script], { input: value, encoding: "utf8" });
    console.log(green(`\n  ✓ installed on ${target} (${wrote.trim()} line)`));
  } catch {
    console.log(red(`\n  Could not write it on ${target}.`));
    console.log(dim("  Re-run with --local to write ./.env.local instead."));
    process.exitCode = 1;
    return;
  }

  console.log(dim("  Restarting so the agent reads it …"));
  const restart = systemdRestartCommand(name);
  try {
    execFileSync("ssh", [target, `${restart} >/dev/null 2>&1 &`], {
      encoding: "utf8",
    });
    console.log(green("  ✓ systemd restart triggered"));
  } catch {
    console.log(yellow(`  ! could not restart — run: ssh ${target} '${restart}'`));
  }

  console.log(
    dim(
      `\n  Check what it can now reach:\n` +
        `    ssh ${target} 'cd ~/${name} && CRED=$(grep -m1 "^KYBERNESIS_AGENT_CREDENTIAL=" .env.local | cut -d= -f2- | tr -d "\\"") && curl -s -H "authorization: Bearer $CRED" ${issuer}/api/agent/peers'\n`,
    ),
  );
}
