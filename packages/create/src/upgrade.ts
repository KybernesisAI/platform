import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EVE_VERSION, bold, capture, dim, green, red, run, yellow } from "./util.js";

const PACKAGES = [
  "@kybernesis/arcana",
  "@kybernesis/enterprise",
  "@kybernesis/multiplayer",
  "@kybernesis/evals",
];

function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}

export async function upgrade(skipEval: boolean): Promise<void> {
  const cwd = process.cwd();
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;

  console.log(bold("\nkyb upgrade — checking @kybernesis/* and eve against npm\n"));
  const toUpgrade: string[] = [];
  for (const name of PACKAGES) {
    if (!deps[name]) continue;
    const installed = capture("node", ["-p", `require('${name}/package.json').version`], cwd)?.trim();
    const latest = capture("npm", ["view", name, "version"])?.trim();
    if (!installed || !latest) {
      console.log(`  ${yellow("!")} ${name}: could not resolve versions`);
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
