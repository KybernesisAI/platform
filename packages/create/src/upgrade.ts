import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bold, capture, dim, green, red, run, yellow } from "./util.js";

const PACKAGES = [
  "@kybernesis/arcana",
  "@kybernesis/enterprise",
  "@kybernesis/multiplayer",
  "@kybernesis/evals",
];

export async function upgrade(skipEval: boolean): Promise<void> {
  const cwd = process.cwd();
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;

  console.log(bold("\nkyb upgrade — checking @kybernesis/* against npm\n"));
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

  if (toUpgrade.length === 0) {
    console.log(`\n${green("Everything is at latest.")}\n`);
    return;
  }

  console.log(bold(`\nInstalling: ${toUpgrade.join(", ")}\n`));
  run("npm", ["install", ...toUpgrade], { cwd });
  run("npm", ["run", "typecheck"], { cwd });

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
