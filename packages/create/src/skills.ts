import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bold, dim, green } from "./util.js";

/** The skill suite shipped inside this package (skills/ beside dist/). */
export function suiteDir(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "skills");
}

/**
 * Install/refresh the Kybernesis FDE skill suite for Claude Code.
 *
 * Default target: ./.claude/skills (the repo you're standing in — the suite
 * then travels with the repo, including through client handover).
 * --global targets ~/.claude/skills for the FDE's own machine.
 *
 * Existing suite skills are overwritten (that IS the update); skills outside
 * the suite are never touched.
 */
export function installSkills(opts: { global?: boolean } = {}): void {
  const src = suiteDir();
  if (!existsSync(src)) {
    console.error("skill suite not found in this install — reinstall @kybernesis/create");
    process.exit(2);
  }
  const target = opts.global
    ? join(homedir(), ".claude", "skills")
    : join(process.cwd(), ".claude", "skills");
  mkdirSync(target, { recursive: true });
  const names = readdirSync(src).filter((n) => !n.startsWith("."));
  for (const name of names) {
    cpSync(join(src, name), join(target, name), { recursive: true });
  }
  console.log(`${green("✓")} ${bold("FDE skill suite")} → ${target}`);
  for (const name of names) console.log(`    ${name}`);
  console.log(
    dim(
      opts.global
        ? "  Available in every Claude Code session on this machine."
        : "  Travels with this repo — every Claude Code session here loads them.",
    ),
  );
}
