/**
 * `kyb model` — read and change which provider binding this agent uses.
 *
 * Why this command exists: the provider is not a config value, it is CODE.
 * `EXE_MODEL` names a model, but which SDK factory wraps it — and therefore
 * which HTTP surface is called — lives in `agent/agent.ts`. Before this
 * command, moving an agent from OpenAI to Claude meant hand-editing generated
 * source, which the next scaffold or upgrade would silently undo.
 *
 * The failure it prevents is expensive because everything upstream looks fine:
 * typecheck clean, eve discovery clean, `kyb doctor` 0 failing, health 200 —
 * and the first turn dies with `unsupported endpoint: /v1/responses` buried in
 * a log that `scripts/eve-server.sh` truncates on every restart.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bold, dim, red, yellow } from "./util.js";
import {
  DEFAULT_MODEL_FOR,
  hostAgentTs,
  type ModelProvider,
} from "./templates.js";

const AGENT_TS = "agent/agent.ts";
const PROVIDERS: ModelProvider[] = ["openai", "claude", "claude-subscription"];

/** What each provider actually costs and needs, said plainly. */
const NOTES: Record<ModelProvider, string> = {
  openai: "exeModel + createOpenAI → /v1/responses. Metered by exe.dev.",
  claude: "createAnthropic → /v1/messages. Metered by exe.dev.",
  "claude-subscription":
    "claudeSubscription() → local OAuth proxy on 127.0.0.1:3333. Billed to a Claude plan.",
};

/**
 * Detect the provider from the generated source rather than from a stored
 * setting. The file is the truth: a hand-edit is then visible instead of
 * disagreeing with a config value nobody looks at.
 */
export function detectProvider(source: string): ModelProvider | "unknown" {
  // Read IMPORTS, not prose. Matching bare identifiers picks up mentions in
  // comments — the generated `claude` binding documents the upgrade path in a
  // comment, and a naive `includes("claudeSubscription(")` reported every such
  // agent as already on the subscription. Caught by running it, 2026-08-23.
  const imports = source
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l))
    .join("\n");
  const calls = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  if (/\bclaudeSubscription\b/.test(imports) && /\bclaudeSubscription\s*\(/.test(calls))
    return "claude-subscription";
  if (/\bcreateAnthropic\b/.test(imports)) return "claude";
  if (/\bexeModel\b/.test(imports)) return "openai";
  return "unknown";
}

/** Read EXE_MODEL out of .env.local, if it is set there. */
function envModel(dir: string): string | undefined {
  const p = join(dir, ".env.local");
  if (!existsSync(p)) return undefined;
  const m = readFileSync(p, "utf8").match(/^EXE_MODEL=["']?([^"'\n]+)/m);
  return m?.[1]?.trim() || undefined;
}

/** Rewrite EXE_MODEL in .env.local, appending it when absent. */
function setEnvModel(dir: string, model: string): boolean {
  const p = join(dir, ".env.local");
  if (!existsSync(p)) return false;
  const current = readFileSync(p, "utf8");
  const line = `EXE_MODEL="${model}"`;
  writeFileSync(
    p,
    /^EXE_MODEL=.*/m.test(current)
      ? current.replace(/^EXE_MODEL=.*/m, line)
      : `${current.replace(/\n*$/, "\n")}${line}\n`,
  );
  return true;
}

export interface ModelOptions {
  /** Provider to switch to. Omitted = report only. */
  set?: string;
  /** Model id. Defaults to the one known to work for that provider. */
  model?: string;
}

export async function model(options: ModelOptions = {}): Promise<void> {
  const dir = process.cwd();
  const agentPath = join(dir, AGENT_TS);

  console.log(`\n${bold("kyb model")}`);

  if (!existsSync(agentPath)) {
    console.log(red(`\n  ✗ no ${AGENT_TS} here — run this inside an agent repo.\n`));
    process.exitCode = 1;
    return;
  }

  const source = readFileSync(agentPath, "utf8");
  const current = detectProvider(source);

  // ── report ────────────────────────────────────────────────────────────
  if (!options.set) {
    const em = envModel(dir);
    console.log(`  provider: ${bold(current)}`);
    console.log(`  model:    ${em ?? dim("(not set in .env.local)")}`);
    if (current !== "unknown") console.log(dim(`  ${NOTES[current]}`));

    if (current === "openai" && em && /^anthropic\/|claude/i.test(em)) {
      console.log(
        red(
          `\n  ✗ MISMATCH: provider "openai" cannot serve model "${em}".`,
        ),
      );
      console.log(
        `    exeModel calls /v1/responses; the gateway answers that with\n` +
          `    "unsupported endpoint" for anthropic models. The first turn will\n` +
          `    fail with a 404 while doctor and health both stay green.\n` +
          `    Fix:  ${bold("kyb model set claude")}`,
      );
      process.exitCode = 1;
    }

    console.log(dim(`\n  change it:  kyb model set <${PROVIDERS.join("|")}> [--model=<id>]\n`));
    return;
  }

  // ── set ───────────────────────────────────────────────────────────────
  const next = options.set as ModelProvider;
  if (!PROVIDERS.includes(next)) {
    console.log(red(`\n  ✗ unknown provider "${options.set}"`));
    console.log(`    known: ${PROVIDERS.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }

  const modelId = options.model ?? DEFAULT_MODEL_FOR[next];
  writeFileSync(agentPath, hostAgentTs("exe", modelId, next));
  console.log(`  ${AGENT_TS} → provider ${bold(next)}, model ${bold(modelId)}`);
  console.log(dim(`  ${NOTES[next]}`));

  if (setEnvModel(dir, modelId)) console.log(`  .env.local → EXE_MODEL="${modelId}"`);
  else console.log(yellow(`  ! no .env.local here — set EXE_MODEL="${modelId}" on the host`));

  if (next === "claude-subscription") {
    console.log(
      yellow(
        `\n  ! The subscription is a PROCESS, not a config file.\n` +
          `    Stand up the OAuth proxy on 127.0.0.1:3333 before deploying —\n` +
          `    node_modules/@kybernesis/exe/patches/README.md — and verify with\n` +
          `    hostPreflight({ claudeProxyUrl: "http://127.0.0.1:3333/v1" }).\n` +
          `    If the proxy is down, every turn fails looking like a model outage.`,
      ),
    );
  }

  console.log(
    dim(`\n  next:  npm run typecheck  →  kyb deploy\n` +
        `  the host keeps its own .env.local — deploy does not resend it.\n`),
  );
}
