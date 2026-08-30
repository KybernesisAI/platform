import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { bold, dim, green, red, run, yellow } from "./util.js";
import { CHANNEL_KINDS, channelPlan, type ChannelKind, type HostKind } from "./templates.js";

/**
 * `kyb add channel <kind>` — put another surface on an agent that already exists.
 *
 * @remarks
 * The scaffold has told people to run this command since the day it shipped,
 * in its own closing summary and in the host-specific steps, and it did not
 * exist. Anyone following those instructions got "no such command" and a
 * suggestion to upgrade, which is a particularly bad failure: the advice is
 * wrong, the fix it proposes does nothing, and the person concludes their
 * install is broken.
 *
 * Everything it needs was already here. `channelPlan` describes each surface —
 * its file, dependencies, registry items, env and human steps — and `init` has
 * always applied that plan. This applies the same plan to a directory that is
 * already an agent, which is all "add" ever meant.
 */
export async function add(what: string | undefined, rest: string[]): Promise<void> {
  if (what !== "channel") {
    console.error(red(`kyb add: don't know how to add "${what ?? ""}".`));
    console.log(dim(`  kyb add channel <${CHANNEL_KINDS.filter((k) => k !== "none").join("|")}>`));
    process.exitCode = 1;
    return;
  }

  const kind = rest.find((a) => !a.startsWith("-")) as ChannelKind | undefined;
  if (!kind || !CHANNEL_KINDS.includes(kind) || kind === "none") {
    console.error(red(`kyb add channel: pick one of ${CHANNEL_KINDS.filter((k) => k !== "none").join(", ")}.`));
    process.exitCode = 1;
    return;
  }

  const dir = resolve(process.cwd());
  if (!existsSync(join(dir, "package.json")) || !existsSync(join(dir, "agent"))) {
    console.error(red("kyb add channel: run this inside an agent directory."));
    process.exitCode = 1;
    return;
  }

  const name = agentNameOf(dir);
  const host: HostKind = existsSync(join(dir, "scripts/eve-server.sh")) ? "exe" : "vercel";
  const plan = channelPlan(kind, name, host);

  console.log(bold(`kyb add channel ${kind}`));
  console.log(dim(`  agent: ${name}\n  host:  ${host}`));

  if (!plan.file) {
    console.error(red(`  ${kind} has no channel file to add.`));
    process.exitCode = 1;
    return;
  }

  const target = join(dir, "agent/channels", plan.file);
  // Refuse rather than overwrite. A channel file is somewhere people put real
  // logic — routing, filters, a greeting — and silently replacing it with the
  // template is not something an "add" command should ever do.
  if (existsSync(target)) {
    console.log(yellow(`  agent/channels/${plan.file} already exists — leaving it alone.`));
  } else {
    mkdirSync(join(dir, "agent/channels"), { recursive: true });
    writeFileSync(target, plan.content);
    console.log(green(`  + agent/channels/${plan.file}`));
  }

  if (plan.deps.length) {
    console.log(bold(`\n  Installing ${plan.deps.join(", ")} …`));
    run("npm", ["install", ...plan.deps, "--no-audit", "--no-fund"], { cwd: dir, allowFail: true });
  }
  for (const item of plan.registryItems) {
    run("npx", ["eve", "add", item, "--overwrite"], { cwd: dir, allowFail: true });
  }

  // Report what was actually written, not what the plan contained. Run twice,
  // the second run adds nothing and saying otherwise sends someone looking in
  // .env.example for variables that were already there.
  const added = appendEnvExample(dir, kind, plan.env);
  if (added) console.log(green(`  + ${added} line(s) in .env.example`));

  console.log(bold("\n  Still to do:"));
  for (const step of plan.steps) console.log(`    · ${step}`);
  console.log(
    dim(
      `\n  Then fill the new values into .env.local and restart:\n` +
        `    ${host === "exe" ? "bash scripts/eve-server.sh" : "kyb deploy"}`,
    ),
  );
}

/** The agent's own name, as the rest of the toolchain reads it. */
function agentNameOf(dir: string): string {
  const env = join(dir, ".env.local");
  if (existsSync(env)) {
    const hit = readFileSync(env, "utf8").match(/^KYBERNESIS_AGENT\s*=\s*"?([^"\n]+)"?/m);
    if (hit?.[1]) return hit[1].trim();
  }
  return basename(dir);
}

/**
 * Append the channel's variables, once.
 *
 * @remarks
 * Appended rather than rewritten so a hand-edited example file survives, and
 * skipped when the key is already present so running the command twice does not
 * leave two copies of every variable for someone to reconcile later.
 */
function appendEnvExample(dir: string, kind: string, lines: string[]): number {
  const path = join(dir, ".env.example");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const fresh = lines.filter((line) => {
    const key = line.split("=")[0]?.trim();
    return key ? !new RegExp(`^${key}\\s*=`, "m").test(existing) : true;
  });
  if (!fresh.length) return 0;
  writeFileSync(path, `${existing.replace(/\n*$/, "\n")}\n# ${kind}\n${fresh.join("\n")}\n`);
  return fresh.length;
}
