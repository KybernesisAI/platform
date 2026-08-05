import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  DEFAULT_ISSUER,
  EVE_VERSION,
  REGISTRY_URL,
  ask,
  bold,
  closePrompts,
  dim,
  green,
  run,
  slug,
  yellow,
} from "./util.js";
import {
  envExample,
  evalFileTs,
  evalScript,
  identityMd,
  rootArcanaTs,
  subagentAgentTs,
  subagentArcanaTs,
  subagentInstructionsMd,
} from "./templates.js";

const ITEMS = ["enterprise", "arcana", "multiplayer", "evals"] as const;

export async function init(rawName: string | undefined): Promise<void> {
  const name = slug(rawName ?? (await ask("Agent name (kebab-case)?", "acme-agent")));
  if (!name) {
    console.error("An agent name is required.");
    process.exit(1);
  }
  const displayName = await ask("Display name (what employees call it)?", name);
  const deptsRaw = await ask(
    "Department subagents (comma-separated, empty for none)?",
    "finance,marketing,engineering",
  );
  const depts = deptsRaw
    .split(",")
    .map((d) => slug(d))
    .filter(Boolean);
  const issuer = await ask("Control-plane issuer?", DEFAULT_ISSUER);
  closePrompts();

  const dir = resolve(process.cwd(), name);
  if (existsSync(dir)) {
    console.error(`Directory ${name}/ already exists.`);
    process.exit(1);
  }

  console.log(bold(`\n1/6  Scaffolding eve agent (eve@${EVE_VERSION}) …`));
  run("npx", [`eve@${EVE_VERSION}`, "init", name]);

  console.log(bold("\n2/6  Adding the Kybernesis registry + packages …"));
  run("npx", ["eve", "registry", "add", `@kybernesis=${REGISTRY_URL}`], { cwd: dir });
  for (const item of ITEMS) {
    run("npx", ["eve", "add", `@kybernesis/${item}`, "--overwrite"], { cwd: dir });
  }

  console.log(bold("\n3/6  Writing agent identity, memory mount, and eval wiring …"));
  mkdirSync(join(dir, "agent/instructions"), { recursive: true });
  writeFileSync(join(dir, "agent/instructions/identity.md"), identityMd(displayName, depts));
  // The scaffold ships a flat agent/instructions.md; the directory form wins,
  // so remove the flat file to avoid ambiguity.
  try {
    unlinkSync(join(dir, "agent/instructions.md"));
  } catch {}
  writeFileSync(join(dir, "agent/extensions/arcana.ts"), rootArcanaTs());
  writeFileSync(join(dir, "evals/kybernesis.eval.ts"), evalFileTs(displayName, depts));

  console.log(bold(`\n4/6  Generating ${depts.length} department subagent(s) …`));
  const skillsSource = join(dir, "node_modules/@kybernesis/arcana/dist/extension/skills");
  for (const dept of depts) {
    const base = join(dir, "agent/subagents", dept);
    mkdirSync(join(base, "connections"), { recursive: true });
    writeFileSync(join(base, "agent.ts"), subagentAgentTs(dept));
    writeFileSync(join(base, "instructions.md"), subagentInstructionsMd(dept));
    writeFileSync(join(base, "connections/arcana.ts"), subagentArcanaTs(dept));
    // Subagents inherit nothing: copy the memory skills from the installed
    // arcana package so each specialist carries the playbooks.
    if (existsSync(skillsSource)) {
      cpSync(skillsSource, join(base, "skills"), { recursive: true });
    } else {
      console.log(yellow(`  ! arcana skills not found at ${skillsSource} — copy them manually`));
    }
  }

  console.log(bold("\n5/6  Env template + hermetic eval script …"));
  writeFileSync(join(dir, ".env.example"), envExample(name, depts, issuer));
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts = { ...pkg.scripts, eval: evalScript(name, depts) };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  console.log(bold("\n6/6  Verifying (typecheck + eve discovery) …"));
  const tsOk = run("npm", ["run", "typecheck"], { cwd: dir, allowFail: true });
  const infoOk = run("npx", ["eve", "info"], { cwd: dir, allowFail: true, quiet: true });
  console.log(tsOk && infoOk ? green("  ✓ typecheck + discovery clean") : yellow("  ! verify manually: npm run typecheck && npx eve info"));

  console.log(`
${green("✓")} ${bold(name)} scaffolded: governed (enterprise) · remembering (arcana) · multiplayer (slack) · self-testing (evals)${depts.length ? ` · ${depts.length} dept subagent(s)` : ""}

${bold("Human steps (in order) — the FDE playbook covers each in detail:")}
  1. Arcana: create workspaces (${name}-company, ${name}-eval${depts.map((d) => `, ${name}-${d}`).join("")}) + scoped kb_ keys; fill .env.local from .env.example
  2. Vercel: \`vercel link\` in ${name}/ (client's team), add envs (prod/preview Sensitive)
  3. Slack: \`vercel connect create slack --triggers --name ${name}\` → detach → re-attach with --trigger-path /eve/v1/slack
  4. Control plane: register agent "${name}" (runtime: ▲ eve) at ${issuer}/agents + grant the pilot cohort
  5. \`npm run eval\` → green → \`npx eve deploy\` → live Slack smoke + the revoke demo
  Run ${bold("kyb doctor")} inside ${name}/ any time to check the wiring.
`);
}
