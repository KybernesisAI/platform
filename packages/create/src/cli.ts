#!/usr/bin/env node
/**
 * kyb — the Kybernesis agent scaffolder and FDE toolkit.
 *
 *   kyb init [name]       scaffold a governed, remembering, multiplayer,
 *                         self-testing eve agent (also: npm create @kybernesis)
 *   kyb doctor            preflight an agent project: keys, issuer, envs, discovery
 *   kyb skills [--global] install/refresh the FDE Claude Code skill suite
 *   kyb upgrade           bump @kybernesis/* to latest, gated on the eval suite
 *     --skip-eval           skip the eval gate (not for production changes)
 */
import { bold, dim } from "./util.js";
import { init } from "./init.js";
import { doctor } from "./doctor.js";
import { upgrade } from "./upgrade.js";
import { installSkills } from "./skills.js";

const [, , command, ...rest] = process.argv;

switch (command) {
  case "init":
    await init(rest.find((a) => !a.startsWith("-")), { engineer: rest.includes("--engineer") });
    break;
  case "doctor":
    await doctor();
    break;
  case "skills":
    installSkills({ global: rest.includes("--global") });
    break;
  case "upgrade":
    await upgrade(rest.includes("--skip-eval"));
    break;
  case undefined:
    await init(undefined, { engineer: false });
    break;
  default:
    if (!command.startsWith("-")) {
      // `npm create @kybernesis acme-agent` → argv[2] is the name.
      await init(command, { engineer: rest.includes("--engineer") });
      break;
    }
    console.log(`
${bold("kyb")} — Kybernesis agent scaffolder & FDE toolkit

  ${bold("kyb init [name]")}     scaffold a full Kybernesis eve agent
      --engineer        ${dim("add the engineer layer: workshop sandbox + vision dev loop")}
  ${bold("kyb doctor")}          preflight checks (keys, issuer, envs, discovery)
  ${bold("kyb skills")}          install/refresh the FDE skill suite for Claude Code
      --global          ${dim("install to ~/.claude/skills instead of this repo")}
  ${bold("kyb upgrade")}         bump @kybernesis/* packages, gated on evals
      --skip-eval       ${dim("skip the eval gate")}

Registry: https://registry.kybernesis.ai · Docs: the FDE playbook
`);
}
