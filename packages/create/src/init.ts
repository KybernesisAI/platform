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
  red,
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
import { systemdRestartCommand } from "./systemd.js";
import { sandboxCleanupScaffoldFiles } from "./sandbox-cleanup.js";

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
  /**
   * The model, as provider/model-id.
   *
   * @remarks
   * Passed straight through to `eve init`, and that is why it exists: without
   * it eve ends its scaffold by opening its interactive model picker, which
   * needs a terminal UI. On a laptop that is a prompt; on a headless machine
   * it is `--input requires the interactive UI` and a scaffold that stops
   * after step one having already written the project — so `--yes` was never
   * actually non-interactive.
   */
  model?: string;
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

  const model = options.model ?? DEFAULT_MODEL;

  console.log(bold(`\n1/6  Scaffolding eve agent (eve@${EVE_VERSION}) …`));
  // eve's scaffold ends by opening its interactive model picker
  // (`eve dev --input /model`), which exits non-zero wherever there is no
  // terminal UI — AFTER the project is fully created and its dependencies
  // installed. Treating that as a failure makes headless scaffolding
  // impossible, which is what a machine building itself has to do.
  //
  // Nothing is lost by ignoring it: agent.ts is overwritten below with our own
  // template carrying the chosen model, so eve's pick would not have survived
  // this function either. `--model` is deliberately NOT passed through — eve
  // refuses an id it cannot find in the AI Gateway catalog and then creates
  // nothing at all, and an exe-hosted agent takes its model from EXE_MODEL,
  // not from the gateway.
  // Two guards, both learned on a real Factory build (KYB-521):
  //  - AI_AGENT: eve's init hands off to `eve dev --onboard` when it sees no
  //    interactive terminal, and that is a server that waits for a person, so a
  //    headless `kyb init` never returned. eve skips the handoff and prints its
  //    summary when it believes a coding agent launched it; the marker is
  //    stripped from eve's own child spawns, so nothing else sees it.
  //  - a timeout, because `--yes` cannot reach a choice eve makes internally,
  //    and a scaffold that cannot finish must fail, not wait forever.
  run("npx", [`eve@${EVE_VERSION}`, "init", name], {
    allowFail: true,
    env: { AI_AGENT: process.env.AI_AGENT?.trim() || "kybernesis-create" },
    timeoutMs: 20 * 60_000,
  });

  // The real test of that step, since its exit code cannot be trusted.
  if (!existsSync(join(dir, "package.json"))) {
    console.error(red(`\n  eve did not create a project in ${dir}. Nothing else can run.`));
    process.exit(1);
  }

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

  const engPlan = engineer ? engineerPlan(host, model) : null;
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
  writeFileSync(join(dir, "agent/agent.ts"), hostAgentTs(host, model));
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

    /**
     * Longer than any turn, because the alternative is answering twice.
     *
     * The local queue delivers a turn by POSTing it to this same server and
     * holds the connection open until the turn finishes, but its client gives
     * up after 30 seconds by default. Any turn slower than that is redelivered
     * and its steps re-run, so the person gets two differently-worded answers
     * to one question with nothing in any log that looks like a fault.
     *
     * Written at scaffold rather than documented: it only affects self-hosted
     * agents, it has one sensible value, and the failure it prevents is one
     * nobody recognises in time.
     */
    known.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = "900000";
    known.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = "900000";
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

    /**
     * The Claude subscription, as a script rather than a procedure.
     *
     * Same reasoning as the restart script above, and the same history: the
     * provider (`claudeSubscription()`) was generalised into @kybernesis/exe
     * after the first agent used it, but STANDING THE PROXY UP stayed a thing
     * someone did by hand on one VM. So the capability was in every agent's
     * packages while the only written procedure was a patch README telling the
     * next person to clone a third-party repository — which is how a client
     * ends up being walked through a git checkout by their consultant.
     *
     * Installed unconditionally for an exe host: it costs one file, and the
     * alternative is rediscovering the procedure per deployment.
     */
    try {
      const proxySource = join(dir, "node_modules/@kybernesis/exe/scripts/claude-subscription.sh");
      const proxyTarget = join(dir, "scripts/claude-subscription.sh");
      copyFileSync(proxySource, proxyTarget);
      chmodSync(proxyTarget, 0o755);
      console.log(dim("     scripts/claude-subscription.sh — put this agent on a Claude subscription, no API key"));
    } catch {
      console.log(
        yellow("  ! could not install scripts/claude-subscription.sh — copy it from node_modules/@kybernesis/exe/scripts/"),
      );
    }

    /**
     * Point management restarts at the one supervisor that owns production.
     *
     * install-service.sh installs systemd with a build-before-start gate. Using
     * eve-server.sh after that would create a second supervisor and can leave
     * two executors racing over one durable store. `-n` makes missing sudo
     * authorization fail instead of hanging a detached Studio restart.
     */
    const manageChannelFile = join(dir, "agent/channels/kyb.ts");
    if (existsSync(manageChannelFile)) {
      const appRoot = `/home/exedev/${name}`;
      const restartCommand = systemdRestartCommand(name);
      const wired = readFileSync(manageChannelFile, "utf8").replace(
        /export default manageChannel\(\{[\s\S]*?\}\);/,
        () =>
          `export default manageChannel({\n` +
          `  appRoot: process.env.EVE_APP_DIR ?? ${JSON.stringify(appRoot)},\n` +
          `  restartCommand: ${JSON.stringify(restartCommand)},\n` +
          `});`,
      );
      writeFileSync(manageChannelFile, wired);
      console.log(dim(`     agent/channels/kyb.ts — restart wired to systemd (${restartCommand})`));
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

  for (const file of sandboxCleanupScaffoldFiles(host, depts)) {
    const full = join(dir, file.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, file.content);
  }

  if (engPlan) {
    for (const file of engPlan.files) {
      const full = join(dir, file.path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, file.content);
    }
  }

  console.log(bold("\n5/6  Env template + hermetic eval script …"));
  writeFileSync(join(dir, ".env.example"), envExample(name, depts, issuer, plan.env, host, model));
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
