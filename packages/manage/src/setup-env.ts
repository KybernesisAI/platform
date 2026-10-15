import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

/**
 * The pure half of the setup routes: which env keys a client may write, how
 * they are written, and the evidence the status route reads.
 *
 * Kept apart from the routes so every rule here is testable without a server,
 * a control plane or a host.
 */

/** What a client may write through `POST /setup/env`, and how each value is checked. */
export interface SetupEnvKey {
  /** The setup item it belongs to, for the status checklist. */
  item: "model" | "slack";
  /** A secret is reported as set or not, never read back. */
  secret: boolean;
  /** What a valid value looks like, in words a person can act on. */
  expects: string;
  valid: (value: string) => boolean;
}

/**
 * The allowlist.
 *
 * Deliberately short. A general env-write route is a way to set anything at
 * all, one authenticated bug away from the most dangerous route in the agent;
 * this one takes only what a person setting the agent up has to type. Keys
 * that something on the host mints (the Linq pair, the VNC password, the
 * agent credential) are written by their own action or route, never here.
 */
/** The routes `KYB_MODEL_REACH` selects between. Mirrors `EXE_MODEL_REACHES` in @kybernesis/exe. */
type SwitchReach = "gateway" | "byok" | "claude-sub" | "grok-sub" | "chatgpt-sub";
const MODEL_REACHES: readonly SwitchReach[] = ["gateway", "byok", "claude-sub", "grok-sub", "chatgpt-sub"];
/** The env variable exeModelReach reads. */
export const MODEL_REACH_ENV = "KYB_MODEL_REACH";

export const SETUP_ENV_KEYS: Record<string, SetupEnvKey> = {
  // The default model reach: the exe LLM gateway, which holds the provider
  // credential itself, so nothing secret is written for it.
  EXE_MODEL: {
    item: "model",
    secret: false,
    expects: "a model id with its provider prefix, e.g. openai/gpt-5.6-sol",
    valid: (v) => /^[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
  },
  // Which of the three routes the agent takes at its next boot, for an agent
  // whose agent/agent.ts uses exeModelReach (@kybernesis/exe). Unset means the
  // route the scaffold authored.
  KYB_MODEL_REACH: {
    item: "model",
    secret: false,
    expects: "one of gateway, byok, claude-sub, grok-sub, chatgpt-sub",
    valid: (v) => MODEL_REACHES.includes(v as SwitchReach),
  },
  // The Grok subscription's model, a bare xAI id. Unset means grok-4.6.
  GROK_MODEL: {
    item: "model",
    secret: false,
    expects: "a bare xAI model id, e.g. grok-4.6",
    valid: (v) => /^grok-[A-Za-z0-9._-]{1,64}$/.test(v),
  },
  // The ChatGPT subscription's model, a bare OpenAI id. Unset means eve's default.
  CHATGPT_MODEL: {
    item: "model",
    secret: false,
    expects: "a bare OpenAI model id, e.g. gpt-6-sol",
    valid: (v) => /^(gpt|o)[A-Za-z0-9._-]{1,64}$/.test(v),
  },
  EXE_LLM_URL: {
    item: "model",
    secret: false,
    expects: "an https URL on an exe.dev integration host, e.g. https://llm.int.exe.xyz/v1",
    valid: (v) => {
      try {
        const url = new URL(v);
        return url.protocol === "https:" && url.hostname.endsWith(".exe.xyz") && !url.username && !url.password;
      } catch {
        return false;
      }
    },
  },
  // Bring your own key: used when KYB_MODEL_REACH=byok (or by an agent
  // authored on a direct provider).
  ANTHROPIC_API_KEY: {
    item: "model",
    secret: true,
    expects: "an Anthropic API key (sk-ant-…)",
    valid: (v) => /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(v),
  },
  OPENAI_API_KEY: {
    item: "model",
    secret: true,
    expects: "an OpenAI API key (sk-…)",
    valid: (v) => /^sk-[A-Za-z0-9_-]{20,300}$/.test(v),
  },
  // Slack with portable credentials: the bot token and signing secret eve's
  // Slack channel reads when it is not on Vercel Connect.
  SLACK_BOT_TOKEN: {
    item: "slack",
    secret: true,
    expects: "a Slack bot token (xoxb-…)",
    valid: (v) => /^xoxb-[A-Za-z0-9-]{10,300}$/.test(v),
  },
  SLACK_SIGNING_SECRET: {
    item: "slack",
    secret: true,
    expects: "a Slack signing secret (32 hex characters)",
    valid: (v) => /^[a-f0-9]{32}$/.test(v),
  },
};

export type EnvUpdate = { set: Record<string, string>; unset: string[] };

/**
 * Check a request body against the allowlist. The error never quotes a value:
 * a mistyped key pasted into the wrong box is still a key.
 */
export function validateEnvUpdate(
  body: unknown,
  allowed: Record<string, SetupEnvKey> = SETUP_ENV_KEYS,
): { ok: true; update: EnvUpdate } | { ok: false; error: string } {
  const input = (body ?? {}) as { set?: unknown; unset?: unknown };
  const set: Record<string, string> = {};
  const unset: string[] = [];
  const names = Object.keys(allowed).join(", ");

  if (input.set !== undefined) {
    if (typeof input.set !== "object" || input.set === null || Array.isArray(input.set)) {
      return { ok: false, error: "set must be an object of KEY: value." };
    }
    for (const [key, raw] of Object.entries(input.set as Record<string, unknown>)) {
      const spec = allowed[key];
      if (!spec) return { ok: false, error: `${key} cannot be set here. Allowed: ${names}.` };
      if (typeof raw !== "string") return { ok: false, error: `${key} must be a string.` };
      const value = raw.trim();
      if (!spec.valid(value)) return { ok: false, error: `${key} does not look right: expected ${spec.expects}.` };
      set[key] = value;
    }
  }
  if (input.unset !== undefined) {
    if (!Array.isArray(input.unset)) return { ok: false, error: "unset must be a list of keys." };
    for (const key of input.unset) {
      if (typeof key !== "string" || !allowed[key]) {
        return { ok: false, error: `${String(key)} cannot be removed here. Allowed: ${names}.` };
      }
      if (key in set) return { ok: false, error: `${key} is both set and unset.` };
      unset.push(key);
    }
  }
  if (!Object.keys(set).length && !unset.length) {
    return { ok: false, error: "Nothing to change: pass set and/or unset." };
  }
  return { ok: true, update: { set, unset } };
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** The keys in an env file and their values, unquoted. Comments and blank lines are skipped. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out.set(match[1], value);
  }
  return out;
}

/**
 * Apply an update to env file text, keeping every other line as it was.
 *
 * A key is replaced where it first appears and any later duplicate is dropped,
 * so the file says one thing; a new key is appended. Values are written the way
 * the credential route always has, double-quoted, which systemd's
 * EnvironmentFile and dotenv both read.
 */
export function applyEnvUpdate(text: string, update: EnvUpdate): { text: string; changed: string[] } {
  const remaining = new Map(Object.entries(update.set));
  const unset = new Set(update.unset);
  const seen = new Set<string>();
  const changed = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const key = LINE.exec(line)?.[1];
    if (key && unset.has(key)) {
      changed.add(key);
      continue;
    }
    if (key && key in update.set) {
      if (seen.has(key)) continue;
      seen.add(key);
      const next = `${key}=${JSON.stringify(update.set[key])}`;
      if (next !== line) changed.add(key);
      lines.push(next);
      remaining.delete(key);
      continue;
    }
    lines.push(line);
  }
  let out = lines.join("\n");
  if (remaining.size) {
    out = out.replace(/\n*$/, "");
    for (const [key, value] of remaining) {
      out += `${out ? "\n" : ""}${key}=${JSON.stringify(value)}`;
      changed.add(key);
    }
    out += "\n";
  }
  return { text: out, changed: [...changed] };
}

/** Read, update and atomically replace an env file, owner-readable only. */
export function writeEnvFile(path: string, update: EnvUpdate): string[] {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { text, changed } = applyEnvUpdate(current, update);
  if (!changed.length) return [];
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  return changed;
}

export function readEnvFile(path: string): Map<string, string> {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

/** How recently a run must have moved to count as a conversation in flight. Matches deploy.sh. */
export const IN_FLIGHT_WINDOW_MS = 600_000;

/**
 * Conversations a restart would cut off: durable runs still `running` that
 * moved in the last ten minutes, counted exactly the way `scripts/deploy.sh`
 * counts them before it will restart an agent.
 *
 * Only real work counts. `sessionTimeoutWorkflow` is a background timer that is
 * always running, and blocking on it would block every restart forever. Files
 * untouched for longer than the window are skipped before they are parsed: a
 * busy host holds thousands of run files and almost all of them are history.
 */
export function inFlightRuns(appRoot: string, now = Date.now()): number {
  const dir = join(appRoot, ".eve", ".workflow-data", "runs");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  let live = 0;
  for (const f of files) {
    const file = join(dir, f);
    try {
      if (now - statSync(file).mtimeMs > IN_FLIGHT_WINDOW_MS) continue;
      const run = JSON.parse(readFileSync(file, "utf8")) as { status?: unknown; workflowName?: unknown; updatedAt?: unknown };
      if (run.status !== "running") continue;
      const name = typeof run.workflowName === "string" ? run.workflowName : "";
      if (!["workflowEntry", "turnWorkflow", "taskRunWorkflow"].some((k) => name.includes(k))) continue;
      const updated = typeof run.updatedAt === "string" ? Date.parse(run.updatedAt) : Number.NaN;
      if (Number.isFinite(updated) && now - updated < IN_FLIGHT_WINDOW_MS) live += 1;
    } catch {
      /* unreadable or mid-write: not evidence either way */
    }
  }
  return live;
}

/** How the root agent reaches its model, read from the source it was built from. */
export type AuthoredReach =
  | "gateway"
  | "claude-sub"
  | "grok-sub"
  | "chatgpt-sub"
  | "byok-anthropic"
  | "byok-openai"
  | "other"
  | "unknown";

/**
 * Classify `agent/agent.ts`, the same evidence `kyb doctor` reads first.
 *
 * The env says what is configured; only the source says what the agent will
 * actually call. A BYOK key stored beside an agent still authored on the
 * gateway is a key nothing reads, and the status route has to be able to say so.
 */
export function classifyAuthoredReach(source: string | null): AuthoredReach {
  if (source === null) return "unknown";
  const found = new Set<AuthoredReach>();
  if (/\bexeModel\s*\(/.test(source)) found.add("gateway");
  // claudeSubscription is built on createAnthropic, so the provider import alone
  // is not evidence of a key.
  if (/\bclaudeSubscription\s*\(/.test(source)) found.add("claude-sub");
  else if (/from\s+["']eve\/models\/anthropic["']/.test(source) || /\bcreateAnthropic\s*\(/.test(source)) {
    found.add("byok-anthropic");
  }
  if (/from\s+["']eve\/models\/openai["']/.test(source) && /\bopenai\s*\(/.test(source)) found.add("byok-openai");
  if (/\bgrokSubscription\s*\(/.test(source)) found.add("grok-sub");
  if (/from\s+["']eve\/models\/openai["']/.test(source) && /\b(experimental_)?chatgpt\s*\(/.test(source)) found.add("chatgpt-sub");
  // Anything else (a gateway string id, a local-only subscription, two reaches
  // at once) is reported as other rather than guessed at.
  return found.size === 1 ? [...found][0] : "other";
}

export function readAuthoredReach(appRoot: string): AuthoredReach {
  try {
    return classifyAuthoredReach(readFileSync(join(appRoot, "agent", "agent.ts"), "utf8"));
  } catch {
    return "unknown";
  }
}

/** The reach the agent takes at its next boot, and whether env can change it. */
export interface ModelReachState {
  reach: AuthoredReach;
  /** The source uses exeModelReach, so `KYB_MODEL_REACH` picks the route. */
  switchable: boolean;
  /** The route the source authors when `KYB_MODEL_REACH` is unset. */
  authored?: AuthoredReach;
  /** `KYB_MODEL_REACH` asked for a route that cannot run; the agent boots on its default instead. */
  fallback?: { requested: string; reason: string };
}

/**
 * The effective reach for an agent authored with `exeModelReach`.
 *
 * The same rules `resolveExeReach` in @kybernesis/exe applies at boot, so the
 * status route says what the agent will actually run rather than what was
 * asked for. Kept here rather than imported: manage does not depend on exe,
 * and the rules are short. Change both together.
 */
export function resolveSwitchedReach(
  source: string,
  get: (key: string) => string | undefined,
  probes: { grok?: () => boolean; chatgpt?: () => boolean } = {},
): ModelReachState | null {
  if (!/\bexeModelReach\s*\(/.test(source)) return null;
  const authoredSwitch = /\breach\s*:\s*["'](gateway|byok|claude-sub|grok-sub|chatgpt-sub)["']/.exec(source)?.[1] as
    | SwitchReach
    | undefined;
  const grokReady = probes.grok ?? (() => grokSignedIn(get("GROK_AUTH_PATH")));
  const chatgptReady = probes.chatgpt ?? (() => codexOnPath() && codexSignedIn(get("CODEX_HOME")));
  // exeModelReach can only build chatgpt-sub when the agent hands it eve's chatgpt.
  const passesChatgpt = /from\s+["']eve\/models\/openai["']/.test(source) && /\bchatgpt\s*[,}]/.test(source);
  const authoredModel = /\bmodel\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
  if (!authoredSwitch) return { reach: "other", switchable: true };

  const model = get("EXE_MODEL") ?? authoredModel ?? "";
  const asReach = (r: SwitchReach): { reach: AuthoredReach; problem?: string } => {
    if (r === "gateway") return { reach: "gateway" };
    if (r === "claude-sub") return { reach: "claude-sub" };
    if (r === "grok-sub") {
      return grokReady()
        ? { reach: "grok-sub" }
        : { reach: "grok-sub", problem: "grok-sub needs a Grok sign-in on this host (grok login), and there is none" };
    }
    if (r === "chatgpt-sub") {
      if (!passesChatgpt) {
        return { reach: "chatgpt-sub", problem: "chatgpt-sub needs an agent/agent.ts that passes chatgpt from eve/models/openai to exeModelReach" };
      }
      return chatgptReady()
        ? { reach: "chatgpt-sub" }
        : { reach: "chatgpt-sub", problem: "chatgpt-sub needs the codex CLI and a ChatGPT sign-in on this host (codex login --device-auth)" };
    }
    const provider = /^(anthropic|openai)\//.exec(model)?.[1];
    if (!provider) {
      return { reach: "byok-openai", problem: `byok needs EXE_MODEL with an anthropic/ or openai/ prefix, and it is ${JSON.stringify(model)}` };
    }
    const reach = provider === "anthropic" ? "byok-anthropic" : "byok-openai";
    const key = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return get(key)?.trim() ? { reach } : { reach, problem: `byok on ${model} needs ${key}, and it is not set` };
  };
  // A misconfigured default is still what boots; it shows as that route, not configured.
  const authored = asReach(authoredSwitch).reach;
  const base = { switchable: true, authored };

  const requested = get(MODEL_REACH_ENV)?.trim() ?? "";
  if (!requested || requested === authoredSwitch) return { ...base, reach: authored };
  if (!MODEL_REACHES.includes(requested as SwitchReach)) {
    return { ...base, reach: authored, fallback: { requested, reason: `${MODEL_REACH_ENV} must be one of ${MODEL_REACHES.join(", ")}` } };
  }
  const chosen = asReach(requested as SwitchReach);
  return chosen.problem
    ? { ...base, reach: authored, fallback: { requested, reason: chosen.problem } }
    : { ...base, reach: chosen.reach };
}

/**
 * Whether `grok login` has left a credential on this host: the same test
 * `readGrokCredential` in @kybernesis/exe makes, by shape rather than by key
 * name, at `GROK_AUTH_PATH` or ~/.grok/auth.json. Says nothing about whether it still authenticates; the CLI refreshes
 * it in place.
 */
export function grokSignedIn(authPath?: string): boolean {
  const path = authPath?.trim() || process.env.GROK_AUTH_PATH?.trim() || join(homedir(), ".grok", "auth.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: unknown } | null>;
    return Object.values(parsed).some((v) => typeof v?.key === "string" && v.key.length > 40);
  } catch {
    return false;
  }
}

/** Whether `codex login` has left a ChatGPT sign-in in `$CODEX_HOME` (default ~/.codex). Mirrors @kybernesis/exe. */
export function codexSignedIn(codexHome?: string): boolean {
  const home = codexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try {
    const parsed = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { tokens?: Record<string, unknown> | null };
    const tokens = parsed.tokens;
    return Boolean(tokens && typeof tokens === "object" && Object.values(tokens).some((v) => typeof v === "string" && v.length > 20));
  } catch {
    return false;
  }
}

/** Whether `codex` is on this process's PATH, which is where eve's chatgpt() looks for it. */
export function codexOnPath(): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => Boolean(dir) && existsSync(join(dir, "codex")));
}

/** Read agent/agent.ts and resolve its reach against an env view (the file first, then the process). */
export function readModelReach(appRoot: string, get: (key: string) => string | undefined): ModelReachState {
  let source: string;
  try {
    source = readFileSync(join(appRoot, "agent", "agent.ts"), "utf8");
  } catch {
    return { reach: "unknown", switchable: false };
  }
  return resolveSwitchedReach(source, get) ?? { reach: classifyAuthoredReach(source), switchable: false };
}
