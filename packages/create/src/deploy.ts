import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { upsertEnv } from "./envfile.js";

import { ask, bold, dim, green, red, yellow } from "./util.js";

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

/**
 * Make sure EXE_MODEL names a model the integration actually serves.
 *
 * `kyb init` leaves it empty on purpose: the valid ids come from the host's
 * integration, and the laptop cannot see them — `llm.int.exe.xyz` resolves only
 * from an attached VM. But nothing then asked again, so a deployment could
 * complete, report healthy, and fail on the first message with an error that
 * never mentions the empty value.
 *
 * The host CAN see the catalog, and this command is already talking to it. So
 * ask it, and offer the ids. Two details worth keeping: the id must carry its
 * provider prefix (`openai/…`), and an unknown id answers `404 unsupported
 * endpoint: /v1/responses` — an error about the endpoint, for a problem with
 * the model.
 */
async function ensureModel(dir: string, target: string): Promise<void> {
  if (env(dir).EXE_MODEL) return;

  console.log(yellow("  EXE_MODEL is empty — the agent has no model to run."));
  console.log(dim("  Asking the host which models its integration serves …"));

  let ids: string[] = [];
  try {
    const raw = execFileSync(
      "ssh",
      [target, "curl -s --max-time 15 https://llm.int.exe.xyz/models.json || true"],
      { encoding: "utf8" },
    );
    type Entry = { id?: string; apis?: string[] };
    const catalog = JSON.parse(raw) as { models?: Entry[]; data?: Entry[] } | Entry[];
    // The live catalog is `{ schema_version, models: [...] }`. `data` and a bare
    // array are accepted too rather than assuming one shape forever.
    const entries: Entry[] = Array.isArray(catalog) ? catalog : (catalog.models ?? catalog.data ?? []);
    ids = entries
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.includes("/"))
      .sort();
  } catch {
    ids = [];
  }

  if (ids.length === 0) {
    console.log(red("\n  Could not read the model catalog from the host."));
    console.log(
      dim(
        `  Check the integration is attached (ssh exe.dev integrations list), then run on the host:\n` +
          `    ssh ${target} 'curl -s https://llm.int.exe.xyz/models.json'\n` +
          `  Set EXE_MODEL to an id WITH its provider prefix, e.g. openai/gpt-5.6-sol.\n`,
      ),
    );
    process.exit(1);
  }

  console.log(dim("\n  Models this host can serve:"));
  ids.forEach((id, i) => console.log(`    ${i + 1}. ${id}`));
  const answer = await ask(`\n  EXE_MODEL (number or full id)?`, ids[0]!);
  const chosen = /^\d+$/.test(answer.trim()) ? ids[Number(answer.trim()) - 1] : answer.trim();
  if (!chosen) {
    console.log(red("  No model chosen — stopping before deploying an agent that cannot answer."));
    process.exit(1);
  }
  upsertEnv(dir, { EXE_MODEL: chosen });
  console.log(green(`  ✓ EXE_MODEL="${chosen}" written to .env.local\n`));
}

export async function deploy(options: { host?: string; dir?: string; noEnv?: boolean }): Promise<void> {
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

  await ensureModel(dir, target);

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
   *
   * `.env.local` is excluded from the SOURCE sync and sent separately below.
   * It is not source: rsync --delete would remove a host-only file, and a
   * half-matching copy is worse than a deliberate one.
   */
  console.log(bold("1/4  Copying source …"));
  const ok = run("rsync", [
    "-az",
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

  /**
   * The agent cannot boot without its environment.
   *
   * This step was missing, and the failure was exactly as opaque as it sounds:
   * source copied, dependencies installed, build succeeded, and the server died
   * on `Invalid extension config: apiKey: expected string, received undefined`
   * — an error about a mount, thirty lines into a log, when the actual cause
   * was that no configuration had ever reached the machine.
   *
   * Sent separately from the source sync so `--delete` cannot touch it, and
   * skippable for deployments whose secrets are managed on the host.
   */
  if (!options.noEnv) {
    const envFile = join(dir, ".env.local");
    if (existsSync(envFile)) {
      console.log(bold("\n2/4  Environment …"));
      /**
       * Only when the host has none.
       *
       * The host's copy is authoritative: it holds credentials minted ON the
       * host, values a laptop never had, and secrets nobody keeps in a working
       * tree. A local stub overwriting it does not misconfigure a deployment,
       * it destroys one — that happened here, to a production agent, and
       * `rsync --delete` took the backup with it in the same run.
       */
      const hasRemote =
        spawnSync("ssh", [target, `test -s ${remote}/.env.local`]).status === 0;
      if (hasRemote) {
        console.log(dim("  host has its own — left untouched"));
      } else if (!run("scp", ["-q", envFile, `${target}:${remote}/.env.local`])) {
        console.log(red("  Could not copy .env.local — the agent will not start without it."));
        process.exitCode = 1;
        return;
      } else {
        console.log(dim("  sent (host had none)"));
      }
    } else {
      console.log(
        yellow(
          "\n  ! No .env.local here. The host needs one, or the agent will fail to boot\n" +
            "    on the first config it dereferences. Run kyb arcana, or create it there.",
        ),
      );
    }
  }

  console.log(bold("\n3/4  Installing dependencies on the host …"));
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
  console.log(bold("\n4/4  Restarting (detached) …"));

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

  /**
   * Wait on PROGRESS, not on a clock.
   *
   * A restart takes seconds, so this used to poll for 200s and then declare
   * failure. A FIRST deploy is not a restart: it installs node_modules and
   * builds from cold, which routinely runs longer than that. The deploy would
   * report "did not report health" and exit non-zero while the build was still
   * running perfectly well — and the honest reading of that message is that the
   * thing is broken, so the next move is usually to kill it and start over.
   *
   * So: give up only when the host goes QUIET (nothing new in the log for a few
   * minutes), and echo each new line meanwhile, because a long wait with
   * visible progress is a different experience from a long wait in silence.
   */
  console.log(dim("\n  Waiting for the restart to report (first deploys build from cold) …"));
  const QUIET_LIMIT_MS = 4 * 60_000;
  const CEILING_MS = 30 * 60_000;
  const startedAt = Date.now();
  let last = "";
  let seen = "";
  let lastChange = Date.now();
  while (Date.now() - startedAt < CEILING_MS) {
    const out = execFileSync("ssh", [target, `tail -40 /tmp/kyb-deploy.log 2>/dev/null || true`], {
      encoding: "utf8",
    });
    last = out;
    if (out !== seen) {
      for (const line of out.split("\n")) {
        if (line && !seen.includes(line) && /npm|install|build|SOURCE IS NEWER|waiting|pid=|health:|FAILED/i.test(line)) {
          console.log(dim(`    ${line.trim().slice(0, 120)}`));
        }
      }
      seen = out;
      lastChange = Date.now();
    }
    if (/health:|FAILED/.test(out)) break;
    if (Date.now() - lastChange > QUIET_LIMIT_MS) {
      console.log(yellow(`\n  ! nothing new on the host for ${Math.round(QUIET_LIMIT_MS / 60_000)} minutes — giving up on the wait`));
      break;
    }
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
      : yellow(
          "\n  ! the restart did not report health. It may still be building — this stops watching, it does not stop the host.\n" +
            `    Watch it:  ssh ${target} 'tail -f /tmp/kyb-deploy.log'`,
        ),
  );
  if (!healthy) process.exitCode = 1;
}
