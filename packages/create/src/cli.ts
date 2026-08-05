#!/usr/bin/env node
/**
 * kyb — the Kybernesis agent scaffolder and FDE toolkit.
 *
 *   kyb init [name]       scaffold a governed, remembering, multiplayer,
 *                         self-testing eve agent (also: npm create @kybernesis)
 *   kyb doctor            preflight an agent project: keys, issuer, envs, discovery
 *   kyb upgrade           bump @kybernesis/* to latest, gated on the eval suite
 *     --skip-eval           skip the eval gate (not for production changes)
 */
import { bold, dim } from "./util.js";
import { init } from "./init.js";
import { doctor } from "./doctor.js";
import { upgrade } from "./upgrade.js";

const [, , command, ...rest] = process.argv;

switch (command) {
  case "init":
    await init(rest.find((a) => !a.startsWith("-")));
    break;
  case "doctor":
    await doctor();
    break;
  case "upgrade":
    await upgrade(rest.includes("--skip-eval"));
    break;
  case undefined:
    // `npm create @kybernesis <name>` lands here with the name in rest? No —
    // npm create passes extra args as argv; treat a bare arg as init's name.
    await init(undefined);
    break;
  default:
    if (!command.startsWith("-")) {
      // `npm create @kybernesis acme-agent` → argv[2] is the name.
      await init(command);
      break;
    }
    console.log(`
${bold("kyb")} — Kybernesis agent scaffolder & FDE toolkit

  ${bold("kyb init [name]")}     scaffold a full Kybernesis eve agent
  ${bold("kyb doctor")}          preflight checks (keys, issuer, envs, discovery)
  ${bold("kyb upgrade")}         bump @kybernesis/* packages, gated on evals
      --skip-eval       ${dim("skip the eval gate")}

Registry: https://registry.kybernesis.ai · Docs: the FDE playbook
`);
}
