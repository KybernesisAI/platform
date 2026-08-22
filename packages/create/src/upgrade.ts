import { existsSync, readFileSync } from "node:fs";
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

export async function upgrade(skipEval: boolean): Promise<void> {
  const cwd = process.cwd();
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;

  console.log(bold("\nkyb upgrade — checking @kybernesis/* and eve against npm\n"));
  warnIfStale();
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
    return;
  }

  console.log(bold(`\nInstalling: ${toUpgrade.join(", ")}\n`));
  run("npm", ["install", ...toUpgrade], { cwd });
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
