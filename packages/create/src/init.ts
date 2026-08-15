import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  CHANNEL_KINDS,
  type ChannelKind,
  type HostKind,
  channelPlan,
  engineerPlan,
  envExample,
  evalFileTs,
  exeEvalConfigTs,
  evalScript,
  hostAgentTs,
  hostSteps,
  identityMd,
  rootArcanaTs,
  subagentAgentTs,
  subagentArcanaTs,
  subagentInstructionsMd,
} from "./templates.js";
import { suiteDir } from "./skills.js";
import { configureArcana } from "./arcana.js";
import { upsertEnv } from "./envfile.js";

/**
 * The always-installed core. Everything else — channels, subagents, engineer,
 * host bindings — is opt-in, because assuming them means the FDE deletes files
 * AND undoes real setup work (an Arcana workspace + scoped key per subagent).
 */
const CORE_ITEMS = ["enterprise", "arcana", "evals"] as const;
// Official eve-registry limbs installed with the engineer subagent.
// connection/vercel is Vercel-Connect-backed, so it is VERCEL-HOST ONLY: on a
// self-hosted agent it cannot get an OIDC token and the agent fails to boot.
const ENGINEER_ITEMS_ALL = ["extension/agent-browser", "extension/github-tools"] as const;
const ENGINEER_ITEMS_VERCEL = ["connection/vercel"] as const;

const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

export interface InitOptions {
  engineer?: boolean;
  /**
   * Wire this agent for KYBER Studio: local execution on the user's own machine,
   * and management routes so Studio can install capabilities and write routines.
   *
   * Off by default. Both let a client reach further than chat does — one onto
   * the user's laptop, one into the agent's own repository — so they are a
   * deliberate choice rather than something an engagement gets by accident.
   */
  studio?: boolean;
  /** Chat surface. Default "none" — add later with `kyb add channel`. */
  channel?: ChannelKind;
  /** Where the agent runs. Default "vercel". */
  host?: HostKind;
  /** Department subagents. Default NONE. */
  subagents?: string[];
  /** Skip prompts and take the flags/defaults as given. */
  yes?: boolean;
}

export async function init(rawName: string | undefined, options: InitOptions = {}): Promise<void> {
  const engineer = options.engineer === true;
  const studio = options.studio === true;
  const nonInteractive = options.yes === true;

  const name = slug(rawName ?? (await ask("Agent name (kebab-case)?", "acme-agent")));
  if (!name) {
    console.error("An agent name is required.");
    process.exit(1);
  }
  const displayName = nonInteractive
    ? name
    : await ask("Display name (what employees call it)?", name);

  // Channel: default NONE. A client on iMessage should never be handed Slack.
  let channel: ChannelKind = options.channel ?? "none";
  if (!options.channel && !nonInteractive) {
    const answer = await ask(
      `Chat surface? (${CHANNEL_KINDS.join(" | ")})`,
      "none",
    );
    const picked = answer.trim().toLowerCase() as ChannelKind;
    channel = CHANNEL_KINDS.includes(picked) ? picked : "none";
  }

  // Host: where it runs. Vercel unless told otherwise.
  let host: HostKind = options.host ?? "vercel";
  if (!options.host && !nonInteractive) {
    const answer = await ask("Host? (vercel | exe)", "vercel");
    host = answer.trim().toLowerCase() === "exe" ? "exe" : "vercel";
  }

  // Subagents: default NONE. Each one costs a workspace + scoped key.
  let depts: string[] = options.subagents ?? [];
  if (!options.subagents && !nonInteractive) {
    const raw = await ask("Department subagents (comma-separated, empty for none)?", "");
    depts = raw.split(",").map((d) => slug(d)).filter(Boolean);
  }

  const issuer = nonInteractive
    ? DEFAULT_ISSUER
    : await ask("Control-plane issuer?", DEFAULT_ISSUER);
  closePrompts();

  const dir = resolve(process.cwd(), name);
  if (existsSync(dir)) {
    console.error(`Directory ${name}/ already exists.`);
    process.exit(1);
  }

  const plan = channelPlan(channel, name, host);

  console.log(bold(`\n1/6  Scaffolding eve agent (eve@${EVE_VERSION}) …`));
  run("npx", [`eve@${EVE_VERSION}`, "init", name]);

  console.log(bold("\n2/6  Adding the Kybernesis registry + core packages …"));
  run("npx", ["eve", "registry", "add", `@kybernesis=${REGISTRY_URL}`], { cwd: dir });
  for (const item of CORE_ITEMS) {
    run("npx", ["eve", "add", `@kybernesis/${item}`, "--overwrite"], { cwd: dir });
  }

  // @ai-sdk/anthropic is for the EVAL JUDGE, not the agent: an agent judged
  // by the model it runs on is a weak test.
  const extraDeps = [
    ...plan.deps,
    ...(host === "exe" ? ["@kybernesis/exe", "@ai-sdk/openai", "@ai-sdk/anthropic"] : []),
  ];
  if (extraDeps.length) {
    console.log(bold(`\n2b   Installing for ${channel}/${host}: ${extraDeps.join(", ")} …`));
    run("npm", ["install", ...extraDeps, "--no-audit", "--no-fund"], { cwd: dir, allowFail: true });
  }
  for (const item of plan.registryItems) {
    run("npx", ["eve", "add", item, "--overwrite"], { cwd: dir, allowFail: true });
  }

  if (studio) {
    // Two separate items on purpose: `local` lets the agent act on the USER'S
    // machine (consent per effect, granted on the desktop); `manage` lets a
    // client change THIS AGENT — its dependencies and its source. Different
    // blast radius, so an agent can have one without the other.
    console.log(bold("\n2b2  KYBER Studio: local execution + management routes …"));
    const studioFailures: string[] = [];
    for (const item of ["local", "manage"]) {
      // The @kybernesis/ prefix is load-bearing: a bare name resolves against
      // eve OWN registry, which has no such item, so both installs failed with
      // "not found" — and allowFail swallowed it. --studio therefore did
      // nothing at all, silently, and the first sign was Studio refusing to
      // connect an agent that looked correctly scaffolded.
      const ok = run("npx", ["eve", "add", `@kybernesis/${item}`, "--overwrite"], {
        cwd: dir,
        allowFail: true,
      });
      if (!ok) {
        studioFailures.push(item);
        console.log(yellow(`  ! ${item} did not install — re-run: npx eve add @kybernesis/${item}`));
      }
    }
    // Said again, loudly, at the end. A warning printed sixty lines before a
    // green summary is a warning nobody reads — and the agent that results
    // looks correctly scaffolded right up until KYBER Studio refuses it.
    if (studioFailures.length) {
      console.log(
        yellow(
          `\n  ! --studio did NOT complete: ${studioFailures.join(", ")} missing.\n` +
            `    This agent cannot be connected to a desktop until they install.`,
        ),
      );
    }
  }

  const engPlan = engineer ? engineerPlan(host, DEFAULT_MODEL) : null;
  if (engPlan) {
    console.log(bold("\n2c   Engineer subagent: workshop sandbox + vision dev loop …"));
    run("npm", ["install", ...engPlan.deps, "--no-audit", "--no-fund"], { cwd: dir, allowFail: true });
    const engItems = [...ENGINEER_ITEMS_ALL, ...(host === "vercel" ? ENGINEER_ITEMS_VERCEL : [])];
    for (const item of engItems) {
      const ok = run("npx", ["eve", "add", item, "--overwrite"], { cwd: dir, allowFail: true });
      if (!ok) console.log(yellow(`  ! ${item} did not install cleanly — re-run: npx eve add ${item}`));
    }
  }

  console.log(bold("\n2d   Seeding the FDE Claude Code skill suite (.claude/skills) …"));
  try {
    cpSync(suiteDir(), join(dir, ".claude/skills"), { recursive: true });
  } catch {
    console.log(yellow("  ! skill suite not found — run kyb skills inside the repo later"));
  }

  console.log(bold("\n3/6  Writing identity, model config, memory mount, and evals …"));
  mkdirSync(join(dir, "agent/instructions"), { recursive: true });
  writeFileSync(join(dir, "agent/instructions/identity.md"), identityMd(displayName, depts));
  try {
    unlinkSync(join(dir, "agent/instructions.md"));
  } catch {}
  writeFileSync(join(dir, "agent/agent.ts"), hostAgentTs(host, DEFAULT_MODEL));
  writeFileSync(join(dir, "agent/extensions/arcana.ts"), rootArcanaTs());
  writeFileSync(join(dir, "evals/kybernesis.eval.ts"), evalFileTs(displayName, depts));
  // A self-hosted agent judges through its own integration; the default
  // resolves through a gateway it has no key for, and only the judged gates
  // fail — which reads as a half-broken agent rather than a missing config.
  if (host === "exe") writeFileSync(join(dir, "evals/evals.config.ts"), exeEvalConfigTs());

  // Ask for the memory keys HERE, while the person is still standing in the
  // scaffold — not in a printed next-step they will read after the context has
  // gone. Skipped with --yes, which is for CI and takes no input by design.
  /**
   * Write the values this command already knows.
   *
   * These were left blank, so the first thing a person met after a clean
   * scaffold was `kyb register` reporting "No agent name" — a step they were
   * never offered, reading as one they had skipped.
   */
  const known: Record<string, string> = { KYBERNESIS_ISSUER: issuer, KYBERNESIS_AGENT: name };
  if (host === "exe") {
    // Usually the agent's name, and usually not. Everything downstream — the
    // deploy target, the registered URL — derives from this one value.
    known.EXE_VM_NAME = options.yes ? name : await ask("exe.dev VM name?", name);
    /**
     * Left empty on purpose rather than guessed.
     *
     * Model ids are per-integration and carry a provider prefix. A hardcoded
     * default put one host's id on another, where an unknown id answers
     * `404 unsupported endpoint` — an error about the endpoint for a problem
     * with the model. Empty fails honestly; the host lists its own with
     * curl https://llm.int.exe.xyz/models.json
     */
    known.EXE_MODEL = "";
  }
  upsertEnv(dir, known);
  if (!options.yes) await configureArcana({ dir, suggest: name, depts });

  /**
   * A self-hosted agent gets its restart script installed, not described.
   *
   * There is no deploy pipeline off Vercel, so restarting IS the release — and
   * the script that does it carries every lesson that path has cost: serialize
   * concurrent restarts, build when the source moved, wait for in-flight turns,
   * and count servers by what they are rather than by who mentions them.
   *
   * It used to ship inside @kybernesis/exe with a line in the docs telling
   * people where to find it, which means a new deployment starts with none of
   * that and rediscovers it one outage at a time.
   */
  if (host === "exe") {
    const source = join(dir, "node_modules/@kybernesis/exe/scripts/eve-server.sh");
    const target = join(dir, "scripts/eve-server.sh");
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      copyFileSync(source, target);
      chmodSync(target, 0o755);
      console.log(dim("     scripts/eve-server.sh — restart with proof (serialized, builds if stale)"));
    } catch {
      console.log(
        yellow("  ! could not install scripts/eve-server.sh — copy it from node_modules/@kybernesis/exe/scripts/"),
      );
    }
  }

  if (plan.file) {
    console.log(bold(`\n4/6  Channel: ${channel} …`));
    mkdirSync(join(dir, "agent/channels"), { recursive: true });
    writeFileSync(join(dir, "agent/channels", plan.file), plan.content);
  } else {
    console.log(bold(`\n4/6  Channel: ${channel} (no channel file) …`));
  }

  if (depts.length) {
    console.log(bold(`\n4b   Generating ${depts.length} department subagent(s) …`));
    const skillsSource = join(dir, "node_modules/@kybernesis/arcana/dist/extension/skills");
    for (const dept of depts) {
      const base = join(dir, "agent/subagents", dept);
      mkdirSync(join(base, "connections"), { recursive: true });
      writeFileSync(join(base, "agent.ts"), subagentAgentTs(dept));
      writeFileSync(join(base, "instructions.md"), subagentInstructionsMd(dept));
      writeFileSync(join(base, "connections/arcana.ts"), subagentArcanaTs(dept));
      if (existsSync(skillsSource)) {
        cpSync(skillsSource, join(base, "skills"), { recursive: true });
      } else {
        console.log(yellow(`  ! arcana skills not found at ${skillsSource} — copy them manually`));
      }
    }
  }

  if (engPlan) {
    for (const file of engPlan.files) {
      const full = join(dir, file.path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, file.content);
    }
  }

  console.log(bold("\n5/6  Env template + hermetic eval script …"));
  writeFileSync(join(dir, ".env.example"), envExample(name, depts, issuer, plan.env, host, DEFAULT_MODEL));
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts = { ...pkg.scripts, eval: evalScript(name, depts) };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  console.log(bold("\n6/6  Verifying (typecheck + eve discovery) …"));
  const tsOk = run("npm", ["run", "typecheck"], { cwd: dir, allowFail: true });
  const infoOk = run("npx", ["eve", "info"], { cwd: dir, allowFail: true, quiet: true });
  console.log(
    tsOk && infoOk
      ? green("  ✓ typecheck + discovery clean")
      : yellow("  ! verify manually: npm run typecheck && npx eve info"),
  );

  const parts = [
    "governed (enterprise)",
    "remembering (arcana)",
    "self-testing (evals)",
    channel === "none" ? null : `${channel} channel`,
    host === "exe" ? "exe.dev host" : null,
    studio ? "KYBER Studio (local execution + management routes)" : null,
    engineer ? "engineer subagent (workshop + vision loop)" : null,
    depts.length ? `${depts.length} dept subagent(s)` : null,
  ].filter(Boolean);

  const steps = [
    `Arcana: create workspaces (${name}-company, ${name}-eval${depts.map((d) => `, ${name}-${d}`).join("")}) + scoped kb_ keys; fill .env.local from .env.example`,
    ...hostSteps(host, name),
    ...plan.steps,
    ...(engPlan?.steps ?? []),
    `Control plane: register agent "${name}" at ${issuer}/agents + grant the pilot cohort`,
    `npm run eval → green → deploy → live smoke + the revoke demo`,
  ];

  console.log(`
${green("✓")} ${bold(name)} scaffolded: ${parts.join(" · ")}

${bold("Human steps (in order) — the FDE playbook covers each in detail:")}
${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

  Run ${bold("kyb doctor")} inside ${name}/ any time to check the wiring.
${dim("  Add more later: kyb add channel <kind> · kyb add subagent <name>")}
`);
}
