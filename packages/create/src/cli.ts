#!/usr/bin/env node
/**
 * kyb — the Kybernesis agent scaffolder and FDE toolkit.
 *
 *   kyb init [name]       scaffold a governed, remembering, multiplayer,
 *                         self-testing eve agent (also: npm create @kybernesis)
 *   kyb doctor            preflight an agent project: keys, issuer, envs, discovery
 *   kyb skills [--global] install/refresh the FDE Claude Code skill suite
 *   kyb arcana            set memory workspaces + keys, and verify them
 *   kyb register          register this agent with the control plane (device flow)
 *   kyb deploy            put this repo on its host and restart it, with proof
 *   kyb upgrade           bump @kybernesis/* to latest, gated on the eval suite
 *     --skip-eval           skip the eval gate (not for production changes)
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bold, dim, red } from "./util.js";
import { init, type InitOptions } from "./init.js";
import { doctor } from "./doctor.js";
import { upgrade } from "./upgrade.js";
import { installSkills } from "./skills.js";
import { deploy } from "./deploy.js";
import { register } from "./register.js";
import { agentName, configureArcana } from "./arcana.js";
import { credential } from "./credential.js";


/** This build's version, so a skew can name itself instead of being guessed at. */
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();

/** Is the working directory already an eve agent, rather than a place to make one? */
function insideAgentProject(): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    return "eve" in deps || existsSync(join(process.cwd(), "agent"));
  } catch {
    return existsSync(join(process.cwd(), "agent"));
  }
}

function flag(rest: string[], key: string): string | undefined {
  const hit = rest.find((a: string) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : undefined;
}
function initOptions(rest: string[]): InitOptions {
  const subs = flag(rest, 'subagents');
  return {
    engineer: rest.includes('--engineer'),
    studio: rest.includes('--studio'),
    channel: flag(rest, "channel") as InitOptions["channel"],
    host: flag(rest, "host") as InitOptions["host"],
    subagents: subs === undefined ? undefined : subs.split(',').map((s) => s.trim()).filter(Boolean),
    yes: rest.includes('--yes') || rest.includes('-y'),
  };
}

const [, , command, ...rest] = process.argv;

switch (command) {
  case "init":
    await init(rest.find((a) => !a.startsWith("-")), initOptions(rest));
    break;
  case "doctor":
    await doctor();
    break;
  case "skills":
    installSkills({ global: rest.includes("--global") });
    break;
  case "arcana":
    // Propose from what the repo says it is. Suggesting "agent-company" to
    // someone standing in an agent called something else reads as a tool that
    // has not looked at their project.
    await configureArcana({
      dir: process.cwd(),
      suggest: flag(rest, "name") ?? agentName(process.cwd(), basename(process.cwd())),
    });
    break;
  case "credential":
    await credential({ name: flag(rest, "name"), host: flag(rest, "host"), local: rest.includes("--local") });
    break;
  case "register":
    await register({ name: flag(rest, "name"), url: flag(rest, "url") });
    break;
  case "deploy":
    await deploy({ host: flag(rest, "host"), noEnv: rest.includes("--no-env") });
    break;
  case "upgrade":
    await upgrade(rest.includes("--skip-eval"));
    break;
  case "--version":
  case "-v":
  case "version":
    console.log(VERSION);
    break;
  case undefined:
    await init(undefined, initOptions(rest));
    break;
  default:
    if (!command.startsWith("-")) {
      // `npm create @kybernesis acme-agent` → argv[2] is the name. Inside an
      // agent repo that reading is almost always wrong: it means a subcommand
      // this build is too old to know, and scaffolding a project named after
      // someone's command is a startling answer to a typo. It has already
      // happened — `kyb arcana` on an older build started a whole new setup
      // instead of asking for keys, so the version skew looked like a missing
      // prompt and cost an afternoon.
      if (insideAgentProject()) {
        console.error(`
${red(`kyb: no such command "${command}"`)}
${dim("  (this looks like an agent project, so it was not read as a new project name)")}

  This kyb is ${bold(VERSION)}. If you expected that command, it is newer:

      ${bold("npm i -g @kybernesis/create@latest")}

  Run ${bold("kyb")} with no arguments for the command list.
`);
        process.exit(1);
      }
      await init(command, initOptions(rest));
      break;
    }
    console.log(`
${bold("kyb")} ${dim(VERSION)} — Kybernesis agent scaffolder & FDE toolkit
${dim("  Every command below exists in this build. If one is missing, the install is older than the docs:")}
${dim("  npm i -g @kybernesis/create@latest")}

  ${bold("kyb init [name]")}     scaffold a Kybernesis eve agent (core: enterprise + arcana + evals)
      --channel=<kind>  ${dim("none|slack|imessage|telegram|discord|web  (default: none)")}
      --host=<kind>     ${dim("vercel|exe                                (default: vercel)")}
      --subagents=a,b   ${dim("department subagents                      (default: none)")}
      --engineer        ${dim("add the engineer layer: workshop sandbox + vision dev loop")}
      --studio          ${dim("wire for KYBER Studio: local execution + management routes")}
      --yes             ${dim("no prompts; take flags and defaults")}
  ${bold("kyb doctor")}          preflight checks (keys, issuer, envs, discovery)
  ${bold("kyb skills")}          install/refresh the FDE skill suite for Claude Code
      --global          ${dim("install to ~/.claude/skills instead of this repo")}
  ${bold("kyb arcana")}          set memory workspaces + keys, and verify each pair
  ${bold("kyb credential")}      mint this agent's control-plane credential and install it
      --local           ${dim("write ./.env.local instead of the host")}
  ${bold("kyb register")}        register this agent with the control plane
      --name=<name>     ${dim("defaults to KYBERNESIS_AGENT in .env.local")}
      --url=<url>       ${dim("defaults to https://$EXE_VM_NAME.exe.xyz")}
  ${bold("kyb deploy")}          copy to the host, install, restart, prove it took
      --host=<target>   ${dim("ssh target; defaults to $EXE_VM_NAME.exe.xyz")}
      --no-env          ${dim("do not send .env.local (host manages its own secrets)")}
  ${bold("kyb upgrade")}         bump @kybernesis/* packages, gated on evals
      --skip-eval       ${dim("skip the eval gate")}

Registry: https://registry.kybernesis.ai · Docs: the FDE playbook
`);
}
