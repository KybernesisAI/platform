import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { finalizeGithubToolsRegistryMount, wireArpAuth } from "./init.js";
import { DISPATCH_DEP, dispatchEveChannelTs, dispatchPeersTs, engineerPlan, type HostKind } from "./templates.js";
import type { ModelScaffoldConfig } from "./model-reach.js";
import { run, yellow } from "./util.js";

/**
 * The capabilities every company agent carries, applied the same way by
 * `kyb init` and by `kyb add` on an agent built before they were standard.
 * Each returns what it wrote, so `add` can report it.
 */

// Official eve-registry limbs installed with the engineer subagent.
// connection/vercel is Vercel-Connect-backed, so it is VERCEL-HOST ONLY: on a
// self-hosted agent it cannot get an OIDC token and the agent fails to boot.
const ENGINEER_ITEMS_ALL = ["extension/agent-browser", "extension/github-tools"] as const;
const ENGINEER_ITEMS_VERCEL = ["connection/vercel"] as const;

function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/**
 * Agent-to-agent: the eve channel becomes the governed dispatch door (people
 * still come in through kybernesisAuth in the same walk) and granted peers
 * become tools. arpAuth is put back into the walk when the agent has the
 * identity item, since the new channel replaces the file that carried it.
 */
export function applyDispatch(dir: string): string[] {
  run("npm", ["install", DISPATCH_DEP, "--no-audit", "--no-fund"], { cwd: dir, allowFail: true });
  let channel = dispatchEveChannelTs();
  if (existsSync(join(dir, "agent/channels/arp.ts"))) channel = wireArpAuth(channel) ?? channel;
  write(dir, "agent/channels/eve.ts", channel);
  write(dir, "agent/tools/peers.ts", dispatchPeersTs());
  return ["agent/channels/eve.ts", "agent/tools/peers.ts"];
}

/**
 * The engineer: a declared `builder` subagent with its own workshop sandbox,
 * memory and skills, plus the browser and GitHub tools at the root.
 */
export function applyEngineer(dir: string, host: HostKind, model: ModelScaffoldConfig): { files: string[]; steps: string[] } {
  const plan = engineerPlan(host, model);
  run("npm", ["install", ...plan.deps, "--no-audit", "--no-fund"], { cwd: dir, allowFail: true });
  const items = [...ENGINEER_ITEMS_ALL, ...(host === "vercel" ? ENGINEER_ITEMS_VERCEL : [])];
  for (const item of items) {
    const ok = run("npx", ["eve", "add", item, "--overwrite"], { cwd: dir, allowFail: true });
    if (item === "extension/github-tools") finalizeGithubToolsRegistryMount(dir, ok);
    if (!ok) console.log(yellow(`  ! ${item} did not install cleanly — re-run: npx eve add ${item}`));
  }
  for (const file of plan.files) write(dir, file.path, file.content);
  // A declared subagent sees none of the root's skills, so the memory skills
  // its instructions name are copied in beside it.
  const skills = join(dir, "node_modules/@kybernesis/arcana/dist/extension/skills");
  if (existsSync(skills)) cpSync(skills, join(dir, "agent/subagents/builder/skills"), { recursive: true });
  else console.log(yellow(`  ! arcana skills not found at ${skills} — copy them into agent/subagents/builder/skills`));
  return { files: plan.files.map((f) => f.path), steps: plan.steps };
}

/**
 * The model config an existing agent was authored with, read back from its
 * agent/agent.ts, so a builder added later runs the same route as its root.
 */
export function modelConfigOf(dir: string): ModelScaffoldConfig {
  const source = existsSync(join(dir, "agent/agent.ts")) ? readFileSync(join(dir, "agent/agent.ts"), "utf8") : "";
  const reach = /\breach\s*:\s*["']([a-z-]+)["']/.exec(source)?.[1];
  const model = /\bmodel\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
  if (reach === "claude-sub") return { reach: "claude-sub", model: (model ?? "claude-opus-5").replace(/^anthropic\//, "") };
  return { reach: "default", model: model ?? "anthropic/claude-sonnet-5" };
}
