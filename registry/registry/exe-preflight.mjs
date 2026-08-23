#!/usr/bin/env node
/**
 * Ask this host whether it can actually run the agent.
 *
 * Run it ON the VM, not from a laptop: most of what it checks is about the
 * host's own environment — whether the model integration is attached, whether
 * the variables `eve start` needs are exported into the process (it does NOT
 * read .env.local the way `eve dev` does), whether file delivery has anywhere
 * to put a file, and whether the local queue's delivery timeout is long enough
 * that a slow turn is not redelivered and answered twice.
 *
 *   node scripts/host-preflight.mjs
 *
 * Every check here exists because its absence cost a real debugging session.
 */
import { hostPreflight } from "@kybernesis/exe";

const result = await hostPreflight({
  appDir: process.cwd(),
  // Name what this agent cannot start without. Anything missing is reported as
  // a variable the service did not export, which is the usual cause.
  requiredEnv: ["KYBERNESIS_ISSUER", "KYBERNESIS_AGENT_CREDENTIAL"],
});

for (const check of result.checks) {
  console.log(`${check.ok ? "\u2713" : "\u2717"} ${check.name}\n    ${check.detail}`);
}
process.exit(result.ok ? 0 : 1);
