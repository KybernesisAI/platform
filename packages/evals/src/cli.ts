#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const CORRUPTION_MARKERS = ["CorruptedEventLogError", "CORRUPTED_EVENT_LOG"] as const;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function lineHasCorruption(line: string): boolean {
  return CORRUPTION_MARKERS.some((marker) => line.includes(marker));
}

export class CorruptionLineCounter {
  #partial = "";
  count = 0;

  push(chunk: string | Buffer): void {
    const text = this.#partial + chunk.toString();
    const lines = text.split("\n");
    this.#partial = lines.pop() ?? "";
    for (const line of lines) this.#count(line);
  }

  finish(): void {
    if (this.#partial.length > 0) this.#count(this.#partial);
    this.#partial = "";
  }

  #count(line: string): void {
    if (lineHasCorruption(line)) this.count += 1;
  }
}

function isResultsLine(line: string): boolean {
  return line.replace(ANSI, "").trimStart().startsWith("Results:");
}

class ConsoleStdout {
  #partial = "";
  #summary = "";
  #holdingSummary = false;

  push(chunk: string | Buffer): void {
    const text = this.#partial + chunk.toString();
    const lines = text.split("\n");
    this.#partial = lines.pop() ?? "";
    for (const line of lines) this.#line(`${line}\n`, line);
  }

  finish(condemned: number): void {
    if (this.#partial.length > 0) this.#line(this.#partial, this.#partial);
    if (this.#holdingSummary) {
      process.stdout.write(`Condemned runs: ${condemned}\n${this.#summary}`);
    } else {
      process.stdout.write(`Condemned runs: ${condemned}\n`);
    }
    this.#partial = "";
  }

  #line(rendered: string, content: string): void {
    if (!this.#holdingSummary && isResultsLine(content)) this.#holdingSummary = true;
    if (this.#holdingSummary) this.#summary += rendered;
    else process.stdout.write(rendered);
  }
}

function localEveCli(cwd: string): string {
  const requireFromProject = createRequire(resolve(cwd, "package.json"));
  const packagePath = requireFromProject.resolve("eve/package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { bin?: string | Record<string, string> };
  const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.eve;
  if (!relative) throw new Error(`eve package at ${packagePath} does not declare an eve binary`);
  return resolve(dirname(packagePath), relative);
}

export async function runEval(args: string[] = process.argv.slice(2)): Promise<number> {
  const cwd = process.cwd();
  const jsonMode = args.some((arg) => arg === "--json" || arg.startsWith("--json="));
  const stdoutCounter = new CorruptionLineCounter();
  const stderrCounter = new CorruptionLineCounter();
  const consoleStdout = jsonMode ? undefined : new ConsoleStdout();

  let cli: string;
  try {
    cli = localEveCli(cwd);
  } catch (error) {
    console.error(`kyb-eval: could not resolve local eve: ${(error as Error).message}`);
    console.error("Condemned runs: 0");
    return 1;
  }

  return await new Promise<number>((resolveExit) => {
    const child = spawn(process.execPath, [cli, "eval", ...args], {
      cwd,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let spawnFailed = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutCounter.push(chunk);
      if (jsonMode) process.stdout.write(chunk);
      else consoleStdout?.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrCounter.push(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      spawnFailed = true;
      console.error(`kyb-eval: failed to start eve eval: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      stdoutCounter.finish();
      stderrCounter.finish();
      const condemned = stdoutCounter.count + stderrCounter.count;
      if (jsonMode) console.error(`Condemned runs: ${condemned}`);
      else consoleStdout?.finish(condemned);

      if (spawnFailed || signal) {
        if (signal) console.error(`kyb-eval: eve eval terminated by signal ${signal}`);
        resolveExit(1);
        return;
      }
      if (code && code !== 0) {
        resolveExit(code);
        return;
      }
      resolveExit(condemned > 0 ? 1 : 0);
    });
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runEval();
}
