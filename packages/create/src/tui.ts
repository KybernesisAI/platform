import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { bold, dim, yellow } from "./util.js";

/**
 * Hand the terminal to the TUI.
 *
 * @remarks
 * The TUI is a compiled binary rather than part of this package, so this
 * command's whole job is finding it and getting out of the way. `stdio:
 * "inherit"` is the load-bearing part: a full-screen app needs the real
 * terminal, not a pipe, and anything that buffers its output turns it into
 * garbage on the way through.
 *
 * The search order is deliberate. PATH first, so a version someone installed
 * on purpose wins; then the two places it actually lands — cargo's bin, and a
 * checkout's release build — because "command not found" is a useless answer
 * when the binary is sitting in one of two well-known directories.
 */
const BINARY = "kyb-tui";

function candidates(): string[] {
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, BINARY));
  return [
    ...onPath,
    join(homedir(), ".cargo", "bin", BINARY),
    join(homedir(), "kyb-tui", "target", "release", BINARY),
  ];
}

export function tui(args: string[]): void {
  const binary = candidates().find((path) => existsSync(path));
  if (!binary) {
    console.log(`\n  ${yellow("The terminal app is not installed on this machine.")}\n`);
    console.log(`  ${bold("cargo install --path .")}  ${dim("from the kyb-tui checkout")}\n`);
    process.exit(1);
  }

  const result = spawnSync(binary, args, { stdio: "inherit" });
  // Exit with what it exited with: a wrapper that always reports success makes
  // the thing it wraps untestable from a script.
  if (result.error) {
    console.error(`\n  Could not start the terminal app: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}
