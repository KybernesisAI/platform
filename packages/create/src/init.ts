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
import { suiteDir } from "./skills.js";

const ITEMS = ["enterprise", "arcana", "multiplayer", "evals"] as const;
// Official eve-registry limbs installed alongside the engineer layer.
const ENGINEER_OFFICIAL_ITEMS = ["extension/agent-browser", "extension/github-tools", "connection/vercel"] as const;

export async function init(
  rawName: string | undefined,
  options?: { engineer?: boolean },
): Promise<void> {
  const engineer = options?.engineer === true;
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
  if (engineer) {
    console.log(bold("\n2b   Engineer layer: workshop sandbox + vision dev loop …"));
    run("npx", ["eve", "add", "@kybernesis/engineer", "--overwrite"], { cwd: dir });
    for (const item of ENGINEER_OFFICIAL_ITEMS) {
      // Official items may carry their own interactive setup; a failure here
      // shouldn't kill the scaffold — the FDE can re-run `eve add <item>`.
      const ok = run("npx", ["eve", "add", item, "--overwrite"], { cwd: dir, allowFail: true });
      if (!ok) console.log(yellow(`  ! ${item} did not install cleanly — re-run: npx eve add ${item}`));
    }
  }

  console.log(bold("\n2c   Seeding the FDE Claude Code skill suite (.claude/skills) …"));
  try {
    cpSync(suiteDir(), join(dir, ".claude/skills"), { recursive: true });
  } catch {
    console.log(yellow("  ! skill suite not found — run kyb skills inside the repo later"));
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
${green("✓")} ${bold(name)} scaffolded: governed (enterprise) · remembering (arcana) · multiplayer (slack) · self-testing (evals)${engineer ? " · engineer (workshop + vision loop)" : ""}${depts.length ? ` · ${depts.length} dept subagent(s)` : ""}${engineer ? `

${bold("Engineer notes:")}
  · The workshop sandbox (agent/sandbox/sandbox.ts) bakes Playwright into the
    template at DEPLOY time — a broken bootstrap fails the Vercel build loudly.
    Deployed sessions run under a domain allowlist; extend it deliberately in
    that file when a project needs another host.
  · Vercel connection (preview deploys + link-back), after \`vercel link\`:
      vercel connect create mcp.vercel.com --name vercel
      vercel connect attach mcp.vercel.com/vercel --yes
    then set connect("mcp.vercel.com/vercel") — the UID, not the short name —
    in agent/connections/vercel.ts. First tool use posts an OAuth link in the
    thread (user-scoped); grant "All projects" so the agent can create new ones,
    then narrow the grant in the dashboard once the project exists.
  · File delivery (the deliver tool needs it):
      vercel blob create-store ${name}-deliverables --access public --yes
    links the store and injects BLOB_READ_WRITE_TOKEN automatically.
  · agent-browser / github-tools may need their Connect setup flows — run
    their printed setup commands if tools 401.` : ""}

${bold("Human steps (in order) — the FDE playbook covers each in detail:")}
  1. Arcana: create workspaces (${name}-company, ${name}-eval${depts.map((d) => `, ${name}-${d}`).join("")}) + scoped kb_ keys; fill .env.local from .env.example
  2. Vercel: \`vercel link\` in ${name}/ (client's team), add envs (prod/preview Sensitive)
  3. Slack: \`vercel connect create slack --triggers --name ${name}\` → detach → re-attach with --trigger-path /eve/v1/slack
  4. Control plane: register agent "${name}" (runtime: ▲ eve) at ${issuer}/agents + grant the pilot cohort
  5. \`npm run eval\` → green → \`npx eve deploy\` → live Slack smoke + the revoke demo
  Run ${bold("kyb doctor")} inside ${name}/ any time to check the wiring.
`);
}
