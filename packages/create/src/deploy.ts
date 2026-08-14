import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bold, dim, green, red, yellow } from "./util.js";

/**
 * `kyb deploy` — put this repo on its host and restart it, with proof.
 *
 * On Vercel this is `eve deploy` and always was. Off Vercel it was a paragraph
 * in a skill telling people to rsync and then run a script, which is the sort
 * of step that gets done differently by each person doing it — and the
 * differences are exactly where the outages came from.
 */

function env(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
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

function hostOf(dir: string): "vercel" | "exe" {
  const pkg = join(dir, "package.json");
  const deps = existsSync(pkg)
    ? (JSON.parse(readFileSync(pkg, "utf8")).dependencies ?? {})
    : {};
  return deps["@kybernesis/exe"] ? "exe" : "vercel";
}

/** The ssh target: an explicit flag, then EVE_SSH_HOST, then the exe VM name. */
function sshTarget(dir: string, explicit?: string): string | null {
  const e = env(dir);
  if (explicit) return explicit;
  if (e.EVE_SSH_HOST) return e.EVE_SSH_HOST;
  if (e.EXE_VM_NAME) return `${e.EXE_VM_NAME}.exe.xyz`;
  return null;
}

export async function deploy(options: { host?: string; dir?: string }): Promise<void> {
  const dir = options.dir ?? process.cwd();
  if (!existsSync(join(dir, "agent"))) {
    console.log(red("Not an eve agent project (no agent/ directory)."));
    process.exitCode = 1;
    return;
  }

  console.log(bold("kyb deploy"));

  if (hostOf(dir) === "vercel") {
    console.log(dim("  host: vercel — handing over to eve deploy\n"));
    const r = spawnSync("npx", ["eve", "deploy"], { cwd: dir, stdio: "inherit" });
    process.exitCode = r.status ?? 0;
    return;
  }

  const target = sshTarget(dir, options.host);
  if (!target) {
    console.log(red("  No host to deploy to."));
    console.log(dim("  Set EXE_VM_NAME (or EVE_SSH_HOST) in .env.local, or pass --host=<ssh target>."));
    process.exitCode = 1;
    return;
  }

  const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name ?? "agent";
  const remote = `~/${name}`;
  console.log(dim(`  host: ${target}   path: ${remote}\n`));

  const run = (cmd: string, args: string[]): boolean => {
    const r = spawnSync(cmd, args, { cwd: dir, stdio: "inherit" });
    return (r.status ?? 1) === 0;
  };

  /**
   * Never copy node_modules, .eve, or a build.
   *
   * node_modules is platform-specific and native modules built on a laptop do
   * not run on the host. `.eve` is the durable store — conversations, turn
   * history, the workflow queue — and overwriting it with a local copy is how
   * a deployment eats its own production state.
   */
  console.log(bold("1/3  Copying source …"));
  const ok = run("rsync", [
    "-az",
    "--delete",
    "--exclude",
    "node_modules",
    "--exclude",
    ".eve",
    "--exclude",
    ".output",
    "--exclude",
    ".git",
    "--exclude",
    ".env.local",
    `${dir}/`,
    `${target}:${remote}/`,
  ]);
  if (!ok) {
    console.log(red("  rsync failed — is the host reachable, and is the path writable?"));
    process.exitCode = 1;
    return;
  }

  console.log(bold("\n2/3  Installing dependencies on the host …"));
  if (!run("ssh", [target, `cd ${remote} && npm install --no-audit --no-fund`])) {
    console.log(red("  npm install failed on the host."));
    process.exitCode = 1;
    return;
  }

  /**
   * Detached, always.
   *
   * `ssh host "script"` sends SIGHUP when the connection ends, which kills the
   * restart halfway — leaving exactly the half-restarted state the script
   * exists to prevent. setsid + nohup + no stdin is the difference between a
   * deploy and an outage.
   */
  console.log(bold("\n3/3  Restarting (detached) …"));

  /**
   * Find the restart script rather than assuming its name.
   *
   * `kyb init` installs scripts/eve-server.sh, but agents predating that have
   * their own — and a deploy that fails on a naming difference is a deploy
   * people stop using. Falls back to installing the packaged script, so a
   * project that has none ends up with the hardened one rather than an error.
   */
  const remoteScript = [
    'SCRIPT=""',
    // A loop, not a chain of `[ -f x ] && echo x || …` — that keeps evaluating
    // after the first hit and yields every match, so SCRIPT becomes three
    // filenames and `bash "$SCRIPT"` fails on a name nothing has.
    "for f in scripts/eve-server.sh scripts/restart.sh eve-server.sh restart.sh; do",
    '  if [ -f "$f" ]; then SCRIPT="$f"; break; fi',
    "done",
    'if [ -z "$SCRIPT" ] && [ -f node_modules/@kybernesis/exe/scripts/eve-server.sh ]; then',
    "  mkdir -p scripts",
    "  cp node_modules/@kybernesis/exe/scripts/eve-server.sh scripts/",
    "  chmod +x scripts/eve-server.sh",
    '  SCRIPT="scripts/eve-server.sh"',
    "fi",
    'if [ -z "$SCRIPT" ]; then echo "FAILED: no restart script on the host"; exit 1; fi',
    'echo "using $SCRIPT"',
    'setsid nohup bash "$SCRIPT" > /tmp/kyb-deploy.log 2>&1 < /dev/null &',
    "sleep 2",
    "echo started",
  ].join("\n");

  run("ssh", [target, `cd ${remote}\n${remoteScript}`]);

  console.log(dim("\n  Waiting for the restart to report …"));
  let last = "";
  for (let i = 0; i < 40; i++) {
    const out = execFileSync("ssh", [target, `tail -6 /tmp/kyb-deploy.log 2>/dev/null || true`], {
      encoding: "utf8",
    });
    last = out;
    if (/health:|FAILED/.test(out)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const healthy = /health:\s*200/.test(last);
  console.log(
    last
      .split("\n")
      .filter((l) => /pid=|build:|OK:|health:|FAILED|SOURCE IS NEWER|^built/.test(l))
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  console.log(
    healthy
      ? green("\n  ✓ deployed and serving the current build")
      : yellow("\n  ! the restart did not report health — check /tmp/kyb-deploy.log on the host"),
  );
  if (!healthy) process.exitCode = 1;
}
