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

/**
 * How many lines after a `CorruptedEventLogError` its `code CORRUPTED_EVENT_LOG`
 * detail can trail. eve prints the two as one block per condemned run; counting
 * both would report twice as many runs as were lost.
 */
const ERROR_BLOCK_LINES = 8;

export class CorruptionLineCounter {
  #partial = "";
  #sinceError = Number.POSITIVE_INFINITY;
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
    this.#sinceError += 1;
    if (line.includes("CorruptedEventLogError")) {
      this.count += 1;
      this.#sinceError = 0;
      return;
    }
    // A bare code line belongs to the error just above it; on its own it is a run.
    if (line.includes("CORRUPTED_EVENT_LOG") && this.#sinceError > ERROR_BLOCK_LINES) {
      this.count += 1;
      this.#sinceError = 0;
    }
  }
}

function isResultsLine(line: string): boolean {
  return line.replace(ANSI, "").trimStart().startsWith("Results:");
}

export class JudgeFailureObserver {
  #partial = { stdout: "", stderr: "" };
  #sawJudgeAssertion = false;
  #sawAutoevalsError = false;
  #status: number | null = null;

  push(chunk: string | Buffer, stream: "stdout" | "stderr"): void {
    const text = this.#partial[stream] + chunk.toString();
    const lines = text.split("\n");
    this.#partial[stream] = lines.pop() ?? "";
    for (const line of lines) this.#observe(line);
  }

  finish(): string | null {
    this.#observe(this.#partial.stdout);
    this.#observe(this.#partial.stderr);
    this.#partial = { stdout: "", stderr: "" };
    if (!this.#sawJudgeAssertion || !this.#sawAutoevalsError) return null;
    return this.#status === null
      ? "Judge failure: the judge could not be reached."
      : `Judge failure: the judge answered ${this.#status}.`;
  }

  #observe(line: string): void {
    const content = line.replace(ANSI, "");
    if (/\bjudge\.autoevals\.[A-Za-z0-9_.-]+/.test(content)) this.#sawJudgeAssertion = true;
    if (/autoevals error:/i.test(content)) this.#sawAutoevalsError = true;
    const status = /(?:HTTP|status(?: code)?|answered)\s*[:=]?\s*(\d{3})\b/i.exec(content)?.[1];
    if (status) this.#status = Number(status);
  }
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

  finish(condemned: number, judgeFailure: string | null): void {
    if (this.#partial.length > 0) this.#line(this.#partial, this.#partial);
    if (this.#holdingSummary) {
      process.stdout.write(`Condemned runs: ${condemned}\n${judgeFailure ? `${judgeFailure}\n` : ""}${this.#summary}`);
    } else {
      process.stdout.write(`Condemned runs: ${condemned}\n${judgeFailure ? `${judgeFailure}\n` : ""}`);
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
  const judgeFailure = new JudgeFailureObserver();

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
      judgeFailure.push(chunk, "stdout");
      if (jsonMode) process.stdout.write(chunk);
      else consoleStdout?.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrCounter.push(chunk);
      judgeFailure.push(chunk, "stderr");
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
      const judgeDiagnostic = judgeFailure.finish();
      if (jsonMode) {
        console.error(`Condemned runs: ${condemned}`);
        if (judgeDiagnostic) console.error(judgeDiagnostic);
      } else {
        consoleStdout?.finish(condemned, judgeDiagnostic);
      }

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
