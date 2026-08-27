import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { upsertEnv } from "./envfile.js";

import { EVE_VERSION, bold, capture, dim, green, red, run, yellow } from "./util.js";

/**
 * Which packages to upgrade: every `@kybernesis/*` this agent depends on.
 *
 * @remarks
 * This was a fixed list of six, written when there were six. Four more shipped
 * afterwards — connectors, local, manage and exe — and an agent using them was
 * told "everything is at latest certified versions" while holding versions from
 * months earlier. A hardcoded list does not fail loudly when it falls behind;
 * it just quietly stops covering things, and the command that reports it is the
 * same one that is wrong.
 *
 * Reading the manifest cannot fall behind. A package added tomorrow is covered
 * by an upgrade run today.
 */
function kybernesisPackages(deps: Record<string, string>): string[] {
  return Object.keys(deps)
    .filter((name) => name.startsWith("@kybernesis/"))
    .sort();
}

function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}


/**
 * Warn when this CLI is itself out of date.
 *
 * @remarks
 * The certified eve version is a constant compiled INTO this tool, so an old
 * kyb reports an old pin as though it were current — and does it with total
 * confidence, in the one command whose entire job is telling you what current
 * means. That failure runs the wrong way round: it tells a healthy agent it is
 * ahead of certified and in "unsupported territory", which invites someone to
 * downgrade a fleet that was fine.
 *
 * Checked here rather than at install because this is the command where being
 * stale changes the answer.
 */
function warnIfStale(): void {
  const installed = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version as string;
  const latest = capture("npm", ["view", "@kybernesis/create", "version"])?.trim();
  if (!latest || latest === installed) return;
  if (!versionLt(installed, latest)) return;
  console.log(
    `  ${yellow("!")} kyb ${installed} is behind ${latest}. The certified eve version is ` +
      `compiled into this tool, so an old kyb reports an old pin as current.`,
  );
  console.log(`    ${dim("npm install -g @kybernesis/create@latest")}\n`);
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

/**
 * Keep the agent host from filling up with what the runtime leaves behind.
 *
 * @remarks
 * eve builds a sandbox template image per session configuration and never
 * collects the old ones, and it leaves session CONTAINERS running — a turn that
 * took four minutes can still own a container, and its writable layer, eight
 * days later. Forty stale images accumulated on one agent in a week; another
 * reached 94% full and began failing in ways that looked like anything but a
 * disk problem. Every self-hosted agent hits this; it is a property of the
 * runtime, not of any one deployment.
 *
 * Installed rather than documented, and DAILY rather than weekly, because the
 * accumulation is measured in gigabytes per day on an agent doing real work.
 * The first version of this ran weekly and was already too slow.
 */
function repairDockerPrune(cwd: string, deps: Record<string, string>): void {
  if (!deps["@kybernesis/exe"]) return;
  if (capture("sh", ["-c", "command -v docker >/dev/null && echo yes"])?.trim() !== "yes") return;

  const installed = capture("sh", ["-c", "test -x /etc/cron.daily/kyb-docker-prune && echo yes"]);
  if (installed?.trim() === "yes") return;

  const source = join(cwd, "node_modules/@kybernesis/exe/scripts/docker-prune.sh");
  if (!existsSync(source)) return;

  // `sudo -n`: this runs inside an upgrade, and an upgrade that stops to ask
  // for a password in the middle of an unattended run is worse than one that
  // says what it could not do.
  const ok = run(
    "sh",
    [
      "-c",
      // The weekly predecessor is removed in the same breath: two jobs pruning
      // the same host is not twice as safe, it is one more thing to reason
      // about when something unexpected disappears.
      `sudo -n cp ${JSON.stringify(source)} /etc/cron.daily/kyb-docker-prune && ` +
        `sudo -n chmod 755 /etc/cron.daily/kyb-docker-prune && ` +
        `sudo -n rm -f /etc/cron.weekly/docker-prune`,
    ],
    { cwd, allowFail: true, quiet: true },
  );

  if (ok) {
    console.log(`  ${green("+")} installed the daily docker reclaim (/etc/cron.daily/kyb-docker-prune)`);
    console.log(
      `    ${dim("eve leaves sandbox images and running session containers behind; this collects them.")}\n`,
    );
  } else {
    console.log(
      `  ${yellow("!")} could not install the docker reclaim job (needs sudo). Without it this host ` +
        `fills with stale sandbox images. Run:\n` +
        `    ${dim("sudo cp node_modules/@kybernesis/exe/scripts/docker-prune.sh /etc/cron.daily/kyb-docker-prune && sudo chmod 755 /etc/cron.daily/kyb-docker-prune")}`,
    );
  }
}

export async function upgrade(skipEval: boolean): Promise<void> {
  const cwd = process.cwd();
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;

  console.log(bold("\nkyb upgrade — checking @kybernesis/* and eve against npm\n"));
  warnIfStale();
  // Env-only, so it is safe before anything is installed.
  repairLocalQueueTimeouts(cwd, deps);
  const toUpgrade: string[] = [];
  const unresolved: string[] = [];
  for (const name of kybernesisPackages(deps)) {
    if (!deps[name]) continue;
    const installed = capture("node", ["-p", `require('${name}/package.json').version`], cwd)?.trim();
    const latest = capture("npm", ["view", name, "version"])?.trim();
    if (!installed || !latest) {
      console.log(`  ${yellow("!")} ${name}: could not resolve versions`);
      unresolved.push(name);
      continue;
    }
    if (installed === latest) console.log(`  ${green("✓")} ${name}@${installed} ${dim("(latest)")}`);
    else {
      console.log(`  ${yellow("↑")} ${name}: ${installed} → ${latest}`);
      toUpgrade.push(`${name}@${latest}`);
    }
  }

  // eve itself: upgrade to the KYBERNESIS-CERTIFIED version, never blindly to
  // npm latest. Certification happens in the platform repo — packages are
  // tested against a new eve, then the pin in @kybernesis/create advances,
  // then this command carries client agents there behind their eval gate.
  let eveChanged = false;
  const eveInstalled = capture("node", ["-p", "require('eve/package.json').version"], cwd)?.trim();
  const eveLatest = capture("npm", ["view", "eve", "version"])?.trim();
  if (eveInstalled) {
    if (versionLt(eveInstalled, EVE_VERSION)) {
      console.log(`  ${yellow("↑")} eve: ${eveInstalled} → ${EVE_VERSION} ${dim("(Kybernesis-certified)")}`);
      toUpgrade.push(`eve@${EVE_VERSION}`);
      eveChanged = true;
    } else if (versionLt(EVE_VERSION, eveInstalled)) {
      console.log(`  ${yellow("!")} eve@${eveInstalled} is AHEAD of the certified ${EVE_VERSION} ${dim("— unsupported territory")}`);
    } else {
      console.log(`  ${green("✓")} eve@${eveInstalled} ${dim("(certified)")}`);
    }
    if (eveLatest && versionLt(EVE_VERSION, eveLatest)) {
      console.log(
        dim(`    note: eve@${eveLatest} exists upstream; ${EVE_VERSION} is the newest Kybernesis-certified version.`),
      );
    }
  }

  if (toUpgrade.length === 0 && unresolved.length > 0) {
    // Saying everything is current, having just failed to check several
    // packages, is the worst available answer: it is the sentence someone
    // repeats to a client. Usually the dependencies are simply not installed
    // here, which is worth naming rather than hiding behind a green tick.
    console.log(
      `\n${yellow(`Checked what could be read. ${unresolved.length} package(s) could not be ` +
        `resolved, so this is not a clean bill of health.`)}\n` +
        `  ${dim("Usually: dependencies are not installed here. Run npm install, then kyb upgrade.")}\n`,
    );
    return;
  }

  if (toUpgrade.length === 0) {
    console.log(`\n${green("Everything is at latest certified versions.")}\n`);
    // Still repair: being on the right versions is not the same as being set
    // up. An agent can sit at latest for weeks with a capability switched off.
    repairBuzzSetup(cwd, deps);
    repairDockerPrune(cwd, deps);
    return;
  }

  console.log(bold(`\nInstalling: ${toUpgrade.join(", ")}\n`));
  run("npm", ["install", ...toUpgrade], { cwd });

  /**
   * Repairs run AFTER the install, not before.
   *
   * Both of these copy files out of packages that the install has just put
   * there — a proxy script, a cron job, a CLI. Running them first meant looking
   * for a file the older installed version did not ship: the repair found
   * nothing, said nothing, and only worked on the NEXT upgrade. Which is a
   * bug that hides itself, because by then it looks like it always worked.
   */
  repairBuzzSetup(cwd, deps);
  repairDockerPrune(cwd, deps);

  run("npm", ["run", "typecheck"], { cwd });
  if (eveChanged) {
    // A framework bump must also pass discovery/compile, not just types.
    const infoOk = run("npx", ["eve", "info"], { cwd, allowFail: true, quiet: true });
    console.log(infoOk ? green("  ✓ eve discovery clean after framework upgrade") : red("  ✗ eve info failed after framework upgrade — inspect before going further"));
  }

  if (skipEval) {
    console.log(yellow("\nEval gate SKIPPED (--skip-eval). Run `npm run eval` before deploying.\n"));
    return;
  }

  console.log(bold("\nRunning the eval gate (npm run eval) — deploy only on green …\n"));
  const ok = run("npm", ["run", "eval"], { cwd, allowFail: true });
  if (ok) {
    console.log(`\n${green("✓ Upgrade green.")} Deploy with: ${bold("npx eve deploy")}\n`);
  } else {
    console.log(`\n${red("✗ Evals failed after upgrade.")} Do NOT deploy — inspect .eve/evals/ artifacts.\n`);
    process.exit(1);
  }
}
