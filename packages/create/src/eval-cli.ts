#!/usr/bin/env node
/**
 * `kyb-eval`: `eve eval` with the two checks eve's own exit code does not make.
 *
 * `kyb upgrade` migrates every agent's `scripts.eval` to this command and runs
 * it as the deploy gate, and the README has described it since 0.14 — but no
 * binary ever shipped, so a migrated agent's `npm run eval` failed with
 * "command not found" and the gate reported red for the wrong reason.
 *
 * What it adds on top of `eve eval <args>`:
 * - a nominally green run that logged condemned durable state
 *   (`CORRUPTED_EVENT_LOG`, `REPLAY_DIVERGENCE`) exits 1 — those runs are
 *   terminal and a suite that passed beside them proves less than it says;
 * - a run whose failures are all judge errors (evaluation model unreachable,
 *   HTTP failures from the judge provider) says so, rather than reading as the
 *   agent under test failing.
 */
import { spawn } from "node:child_process";

const CONDEMNED = /CORRUPTED_EVENT_LOG|REPLAY_DIVERGENCE/;
const JUDGE_FAILURE = /judge[^\n]*(unreachable|ECONNREFUSED|fetch failed|HTTP \d{3}|Unauthenticated|no credentials|not valid)/i;

function main(): void {
  const args = process.argv.slice(2);
  // An eval's routine deliveries land in throwaway sessions; they must never
  // become the agent's canonical conversation (see @kybernesis/manage).
  const env = { ...process.env, KYB_CANONICAL_SESSION: "off" };
  const child = spawn("npx", ["eve", "eval", ...args], { stdio: ["inherit", "pipe", "pipe"], env });
  let condemned = 0;
  let judgeFailures = 0;
  const scan = (chunk: Buffer, out: NodeJS.WriteStream): void => {
    const text = chunk.toString();
    out.write(text);
    for (const line of text.split("\n")) {
      if (CONDEMNED.test(line)) condemned += 1;
      if (JUDGE_FAILURE.test(line)) judgeFailures += 1;
    }
  };
  child.stdout.on("data", (chunk: Buffer) => scan(chunk, process.stdout));
  child.stderr.on("data", (chunk: Buffer) => scan(chunk, process.stderr));
  child.on("error", (error) => {
    console.error(`kyb-eval: could not start eve eval: ${error.message}`);
    process.exit(2);
  });
  child.on("close", (code) => {
    if (condemned > 0) {
      console.error(
        `\nkyb-eval: ${condemned} condemned durable-state diagnostic(s) seen (CORRUPTED_EVENT_LOG / REPLAY_DIVERGENCE). ` +
          "Those conversations are terminal; treating this run as red.",
      );
      process.exit(1);
    }
    if (code !== 0 && judgeFailures > 0) {
      console.error(
        `\nkyb-eval: ${judgeFailures} judge failure(s) seen — the evaluation model was unreachable or refused, ` +
          "which is a judge-reachability problem, not evidence that the agent under test failed. Fix the judge, then rerun.",
      );
    }
    process.exit(code ?? 1);
  });
}

main();
