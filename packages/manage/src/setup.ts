import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GET, POST, type RouteDefinition } from "eve/channels";
import {
  inFlightRuns,
  MODEL_REACH_ENV,
  readModelReach,
  readEnvFile,
  validateEnvUpdate,
  writeEnvFile,
  type AuthoredReach,
} from "./setup-env.js";
import {
  bridgeState,
  bridgeUnitName,
  buzzIdentity,
  buzzKeyFile,
  installBridgeUnit,
  parseProfileOutput,
  parseRelays,
  type BridgeState,
  type RelayOutcome,
} from "./buzz.js";

/**
 * Setup routes: the steps that used to need a terminal on the agent's host,
 * as calls a signed-in owner's client can make.
 *
 *   GET  /eve/v1/kyb/setup         every setup item and whether it is done
 *   POST /eve/v1/kyb/setup/env     set allowlisted env values, then restart safely
 *   POST /eve/v1/kyb/setup/action  run a named step and return what the person needs
 *
 * Owner-only: these write secrets and restart the agent, so a `use` grant that
 * may talk to the agent may not set it up. Every value a person types travels
 * in a request body or on a child's stdin, never in a command line, and no
 * secret is ever read back out.
 */

export interface SetupOptions {
  /** The computer's container name. Defaults to COMPUTER_NAME, then "agent-computer". */
  computerName?: string;
  /**
   * The Claude subscription proxy's container. Defaults to CLAUDE_PROXY_NAME,
   * then `<app folder>-claude-subscription`, which is what
   * `scripts/claude-subscription.sh` names it.
   */
  claudeProxyName?: string;
  /** Where that proxy listens on loopback. Defaults to CLAUDE_PROXY_PORT, then 3333. */
  claudeProxyPort?: number;
  /**
   * This agent's public https origin, for webhooks that must reach it (Linq).
   * Defaults to KYB_PUBLIC_URL, then `https://<EXE_VM_NAME>.exe.xyz:8000`.
   */
  publicUrl?: string;
  /** Linq's CLI, pinned: a CLI that changes under a fleet changes every signup. */
  linqCli?: string;
  /** Test seams. */
  exec?: Exec;
  start?: Start;
  launch?: Launch;
  now?: () => number;
  restarter?: SafeRestarter;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type Exec = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
) => Promise<ExecResult>;
export type Start = (file: string, args: string[], opts: { cwd: string }) => ChildProcessWithoutNullStreams;
export type Launch = (script: string, cwd: string) => void;

const LINQ_CLI = "@linqapp/cli@2.7.0";
const LINQ_EVENTS = "message.received,reaction.added,reaction.removed";
const RESTART_DELAY_MS = 20_000;
const CLAUDE_LOGIN_TTL_MS = 10 * 60_000;

/**
 * Commands run through a login shell, so `npx` and `docker` resolve the way
 * they do for a person on the host, but the arguments are passed as argv and
 * never interpolated into the script.
 */
function viaLoginShell(file: string, args: string[]): [string, string[]] {
  return [process.env.SHELL ?? "/bin/bash", ["-lc", 'exec "$0" "$@"', file, ...args]];
}

export const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    const [shell, argv] = viaLoginShell(file, args);
    // stdin closed: every CLI here takes its non-interactive path.
    const child = spawn(shell, argv, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", NO_UPDATE_NOTIFIER: "1", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    const cap = 200_000;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${String(e)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export const defaultStart: Start = (file, args, opts) => {
  const [shell, argv] = viaLoginShell(file, args);
  return spawn(shell, argv, { cwd: opts.cwd, env: { ...process.env, NO_COLOR: "1" } });
};

export const defaultLaunch: Launch = (script, cwd) => {
  spawn(process.env.SHELL ?? "/bin/bash", ["-lc", script], { cwd, detached: true, stdio: "ignore" }).unref();
};

// ── Restarting without cutting anyone off ──────────────────────────────────

export interface RestartState {
  restart: "none" | "scheduled" | "waiting" | "manual";
  inFlight: number;
  note: string;
}

/**
 * One restart for any number of changes, and never in the middle of a turn.
 *
 * A setup change does nothing until the process restarts (env is read at
 * boot), and restarting mid-turn corrupts that conversation for good. So a
 * request is coalesced with any already pending, waits the usual twenty
 * seconds, and then waits for quiet: no conversation in flight by the same
 * count deploy.sh uses. A host that never goes quiet is left alone after two
 * hours; the status route keeps saying a restart is owed.
 */
export class SafeRestarter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private since: number | undefined;
  private readonly before = new Set<string>();
  private lastInFlight = 0;

  constructor(
    private readonly o: {
      appRoot: string;
      restartCommand?: string;
      delayMs?: number;
      pollMs?: number;
      giveUpMs?: number;
      now?: () => number;
      inFlight?: (appRoot: string) => number;
      launch?: Launch;
    },
  ) {}

  /** `before` runs ahead of the restart, after the quiet check (e.g. removing a container to recreate). */
  request(before?: string): RestartState {
    if (!this.o.restartCommand) {
      return { restart: "manual", inFlight: 0, note: "Stored. It takes effect at the next restart." };
    }
    if (before) this.before.add(before);
    const now = (this.o.now ?? Date.now)();
    this.since ??= now;
    if (!this.timer) this.schedule(this.o.delayMs ?? RESTART_DELAY_MS);
    return this.state();
  }

  state(): RestartState {
    if (!this.o.restartCommand) {
      return { restart: "manual", inFlight: 0, note: "No restart command is configured; restart the agent to apply." };
    }
    if (!this.timer) return { restart: "none", inFlight: 0, note: "No restart pending." };
    return this.lastInFlight > 0
      ? {
          restart: "waiting",
          inFlight: this.lastInFlight,
          note: "Stored. The agent restarts to apply it as soon as no conversation is in progress.",
        }
      : { restart: "scheduled", inFlight: 0, note: "Stored. The agent is restarting to apply it and will be briefly unavailable." };
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => this.tick(), ms);
    this.timer.unref?.();
  }

  private tick(): void {
    const now = (this.o.now ?? Date.now)();
    const live = (this.o.inFlight ?? inFlightRuns)(this.o.appRoot);
    this.lastInFlight = live;
    if (live > 0) {
      if (now - (this.since ?? now) > (this.o.giveUpMs ?? 2 * 60 * 60_000)) {
        this.timer = undefined;
        this.since = undefined;
        this.before.clear();
        return;
      }
      this.schedule(this.o.pollMs ?? 30_000);
      return;
    }
    const steps = [...this.before].map((b) => `{ ${b} || true; }`);
    const script = [...steps, this.o.restartCommand!].join("; ");
    this.timer = undefined;
    this.since = undefined;
    this.before.clear();
    (this.o.launch ?? defaultLaunch)(script, this.o.appRoot);
  }
}

// ── Facts the status route reads ───────────────────────────────────────────

/** Non-secret notes about setup steps, kept beside the repo so a restart does not forget them. */
interface SetupState {
  linq?: { email?: string; number?: string; webhookId?: string; at?: string };
  vnc?: { rotatedAt?: string };
  link?: { startedAt?: string };
  /** The agent's public key (cached: reading it means running the Buzz CLI) and where it was last connected. */
  buzz?: { keyFile?: string; npub?: string; hex?: string; relays?: string[]; members?: string[]; at?: string };
}

function stateFile(appRoot: string): string {
  return join(appRoot, ".kyb-setup.json");
}

export function readSetupState(appRoot: string): SetupState {
  try {
    return JSON.parse(readFileSync(stateFile(appRoot), "utf8")) as SetupState;
  } catch {
    return {};
  }
}

function writeSetupState(appRoot: string, patch: (s: SetupState) => void): void {
  const state = readSetupState(appRoot);
  patch(state);
  const tmp = `${stateFile(appRoot)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, stateFile(appRoot));
}

function dependencies(appRoot: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return new Set(Object.keys(pkg.dependencies ?? {}));
  } catch {
    return new Set();
  }
}

function channelFiles(appRoot: string): string[] {
  try {
    return readdirSync(join(appRoot, "agent", "channels"));
  } catch {
    return [];
  }
}

/** True when the Slack channel reads its app from the control plane rather than env. */
function channelUsesControlPlaneSlack(appRoot: string, channels: string[]): boolean {
  const file = channels.find((f) => /slack/i.test(f));
  if (!file) return false;
  try {
    return readFileSync(join(appRoot, "agent", "channels", file), "utf8").includes("controlPlaneSlackCredentials");
  } catch {
    return false;
  }
}

async function controlPlaneSlackState(
  issuer: string | undefined,
  credential: string | undefined,
): Promise<"installed" | "created" | "none" | "unknown"> {
  if (!credential) return "unknown";
  try {
    const res = await fetch(`${(issuer || "https://agent.kybernesis.ai").replace(/\/$/, "")}/api/agent/slack`, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) return "none";
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { botToken?: unknown };
    return typeof body.botToken === "string" && body.botToken ? "installed" : "created";
  } catch {
    return "unknown";
  }
}

export function publicUrlFor(explicit?: string): string | undefined {
  const raw = explicit ?? process.env.KYB_PUBLIC_URL;
  if (raw) {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" ? url.origin : undefined;
    } catch {
      return undefined;
    }
  }
  const vm = process.env.EXE_VM_NAME;
  return vm && /^[a-z0-9][a-z0-9-]{0,62}$/.test(vm) ? `https://${vm}.exe.xyz:8000` : undefined;
}

function linkAuthFile(): string {
  if (process.env.LINK_AUTH_FILE) return process.env.LINK_AUTH_FILE;
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "link-cli-nodejs", "config.json");
}

function linkSignedIn(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(linkAuthFile(), "utf8")) as { auth?: { access_token?: unknown } | null };
    return typeof parsed.auth?.access_token === "string" && parsed.auth.access_token.length > 0;
  } catch {
    return false;
  }
}

/** Is the subscription actually authenticating? Asks the API through the proxy, not its liveness endpoint. */
async function subscriptionState(port: number): Promise<"signed-in" | "signed-out" | "not-running"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { "anthropic-version": "2023-06-01", "x-api-key": "claude-subscription-local-proxy" },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? "signed-in" : "signed-out";
  } catch {
    return "not-running";
  }
}

export interface SetupItem {
  id: "identity" | "model" | "computer" | "slack" | "imessage" | "buzz" | "wallet";
  required: boolean;
  done: boolean;
  detail: string;
  /** Actions (`POST /setup/action`) and env keys (`POST /setup/env`) that move it forward. */
  actions: string[];
  env: string[];
}

export interface SetupStatus {
  model: {
    reach: AuthoredReach;
    /** agent/agent.ts uses exeModelReach: `KYB_MODEL_REACH` (via POST /setup/env) picks the route. */
    switchable: boolean;
    /** The route the source authors when `KYB_MODEL_REACH` is unset (switchable agents only). */
    authored?: AuthoredReach;
    /** `KYB_MODEL_REACH` names a route that cannot run, so the agent boots on its authored one. */
    fallback?: { requested: string; reason: string };
    gateway: { model: string | null; url: string };
    byok: { anthropic: boolean; openai: boolean };
    subscription: "signed-in" | "signed-out" | "not-running";
  };
  restart: RestartState & { configured: boolean; owed: boolean };
  items: SetupItem[];
  /** Present when the agent has Buzz installed (`kyb add buzz`). */
  buzz?: BuzzStatus;
}

export interface BuzzStatus {
  /** The key an admin adds to the community; null until the agent has one. */
  npub: string | null;
  hex: string | null;
  relays: string[];
  /** Communities where the last connect found the agent a member. */
  members: string[];
  bridge: BridgeState;
}

const REACH_WORDS: Record<AuthoredReach, string> = {
  gateway: "the exe LLM gateway",
  "claude-sub": "a Claude subscription",
  "byok-anthropic": "its own Anthropic key",
  "byok-openai": "its own OpenAI key",
  other: "a model set in agent/agent.ts",
  unknown: "an unknown route (no agent/agent.ts)",
};

export async function setupStatus(input: {
  appRoot: string;
  agent?: string;
  options: SetupOptions;
  restarter: SafeRestarter;
  restartCommand?: string;
}): Promise<SetupStatus> {
  const { appRoot, options } = input;
  const envPath = join(appRoot, ".env.local");
  const env = readEnvFile(envPath);
  const get = (key: string) => env.get(key) || process.env[key];
  const has = (key: string) => Boolean(get(key));
  const deps = dependencies(appRoot);
  const channels = channelFiles(appRoot);
  const saved = readSetupState(appRoot);
  const reachState = readModelReach(appRoot, get);
  const reach = reachState.reach;
  const port = options.claudeProxyPort ?? (Number(process.env.CLAUDE_PROXY_PORT) || 3333);
  const subscription = await subscriptionState(port);
  const gatewayModel = env.get("EXE_MODEL") ?? process.env.EXE_MODEL ?? null;

  const modelDone =
    reach === "gateway"
      ? Boolean(gatewayModel)
      : reach === "claude-sub"
        ? subscription === "signed-in"
        : reach === "byok-anthropic"
          ? has("ANTHROPIC_API_KEY")
          : reach === "byok-openai"
            ? has("OPENAI_API_KEY")
            : reach === "other";
  const fallbackNote = reachState.fallback
    ? ` ${MODEL_REACH_ENV}=${reachState.fallback.requested} is not used: ${reachState.fallback.reason}.`
    : "";
  const modelDetail =
    (modelDone
      ? `Reaches its model through ${REACH_WORDS[reach]}${reach === "gateway" && gatewayModel ? ` (${gatewayModel})` : ""}.`
      : reach === "claude-sub"
        ? "Set to a Claude subscription that is not signed in."
        : `Set to ${REACH_WORDS[reach]}, which is not configured yet.`) + fallbackNote;

  const items: SetupItem[] = [
    {
      id: "identity",
      required: true,
      done: has("KYBERNESIS_AGENT_CREDENTIAL"),
      detail: has("KYBERNESIS_AGENT_CREDENTIAL")
        ? "Identifies itself to the control plane."
        : "Has no control-plane credential yet; whoever set it up finishes this.",
      actions: [],
      env: [],
    },
    {
      id: "model",
      required: true,
      done: modelDone,
      detail: modelDetail,
      actions: ["claude.login"],
      env: [...(reachState.switchable ? [MODEL_REACH_ENV] : []), "EXE_MODEL", "EXE_LLM_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    },
  ];
  if (deps.has("@kybernesis/computer")) {
    items.push({
      id: "computer",
      required: true,
      done: has("COMPUTER_VNC_PASSWORD"),
      detail: has("COMPUTER_VNC_PASSWORD")
        ? `Its screen has a password${saved.vnc?.rotatedAt ? ` (set ${saved.vnc.rotatedAt})` : ""}.`
        : "Its screen has no password yet.",
      actions: ["vnc.password"],
      env: [],
    });
  }
  const slackChannel = channels.some((f) => /slack/i.test(f));
  const slackFromControlPlane = slackChannel && channelUsesControlPlaneSlack(appRoot, channels);
  if (slackFromControlPlane) {
    // The agent's own Slack app lives in the control plane; ask it whether the
    // customer has installed it, with the same credential the channel uses.
    const app = await controlPlaneSlackState(get("KYBERNESIS_ISSUER"), get("KYBERNESIS_AGENT_CREDENTIAL"));
    items.push({
      id: "slack",
      required: false,
      done: app === "installed",
      detail:
        app === "installed"
          ? "In Slack as its own app."
          : app === "created"
            ? "Its Slack app is ready to add to your workspace."
            : app === "none"
              ? "Its Slack app has not been made yet."
              : "Could not reach the control plane to check Slack.",
      actions: [],
      env: [],
    });
  } else {
    const slackKeys = has("SLACK_BOT_TOKEN") && has("SLACK_SIGNING_SECRET");
    items.push({
      id: "slack",
      required: false,
      done: slackKeys && slackChannel,
      detail: !slackChannel
        ? "No Slack channel is installed on this agent."
        : slackKeys
          ? "Slack credentials are stored."
          : "The Slack channel is installed but has no bot token and signing secret.",
      actions: [],
      env: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    });
  }
  const linqKeys = has("LINQ_API_KEY") && has("LINQ_WEBHOOK_SECRET");
  const linqChannel = channels.some((f) => /^linq\.(ts|js|mjs)$/.test(f));
  items.push({
    id: "imessage",
    required: false,
    done: linqKeys && linqChannel,
    detail: linqKeys
      ? `Has an iMessage line${saved.linq?.number ? ` (${saved.linq.number})` : ""}${linqChannel ? "." : ", but no Linq channel is installed to answer it."}`
      : saved.linq?.email
        ? `Waiting for the code emailed to ${saved.linq.email}.`
        : "No iMessage line yet.",
    actions: linqKeys ? ["linq.contacts", "linq.contact.add", "linq.contact.remove"] : ["linq.signup", "linq.verify"],
    env: [],
  });
  let buzz: BuzzStatus | undefined;
  if (deps.has("@kybernesis/buzz")) {
    const exec = options.exec ?? defaultExec;
    const identity = await cachedBuzzIdentity(exec, appRoot, buzzKeyFile(get));
    const relays = (get("BUZZ_RELAY") ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    const agent = agentName(appRoot, input.agent, get);
    const bridge = agent ? await bridgeState(exec, appRoot, bridgeUnitName(agent)) : "unknown";
    const members = (saved.buzz?.members ?? []).filter((m) => relays.includes(m));
    buzz = { npub: identity?.npub ?? null, hex: identity?.hex ?? null, relays, members, bridge };
    const hosts = (list: string[]) => list.map((r) => r.replace(/^wss:\/\//, "")).join(", ");
    items.push({
      id: "buzz",
      required: false,
      done: relays.length > 0 && bridge === "active" && members.length > 0,
      detail: !relays.length
        ? identity
          ? "Ready for your Buzz community: an admin adds its key, then connect it with the community's address."
          : "Buzz is installed but the agent has no key yet; connecting makes one."
        : bridge !== "active"
          ? `Connected to ${hosts(relays)}, but its bridge is ${bridge === "missing" ? "not installed" : bridge === "failed" ? "failing" : "off"}.`
          : members.length < relays.length
            ? `Waiting for an admin to add its key in ${hosts(relays.filter((r) => !members.includes(r)))}, then connect again.`
            : `In Buzz (${hosts(relays)}).`,
      actions: ["buzz.join", "buzz.leave"],
      env: [],
    });
  }
  if (deps.has("@kybernesis/payments")) {
    const signedIn = linkSignedIn();
    items.push({
      id: "wallet",
      required: false,
      done: signedIn,
      detail: signedIn ? "The Link wallet is signed in." : "The Link wallet is not signed in.",
      actions: ["link.login"],
      env: [],
    });
  }

  let owed = false;
  try {
    owed = statSync(envPath).mtimeMs > Date.now() - process.uptime() * 1000;
  } catch {
    /* no env file: nothing to apply */
  }
  return {
    model: {
      reach,
      switchable: reachState.switchable,
      ...(reachState.authored ? { authored: reachState.authored } : {}),
      ...(reachState.fallback ? { fallback: reachState.fallback } : {}),
      gateway: { model: gatewayModel, url: env.get("EXE_LLM_URL") ?? process.env.EXE_LLM_URL ?? "https://llm.int.exe.xyz/v1" },
      byok: { anthropic: has("ANTHROPIC_API_KEY"), openai: has("OPENAI_API_KEY") },
      subscription,
    },
    restart: { ...input.restarter.state(), configured: Boolean(input.restartCommand), owed: owed || input.restarter.pending },
    items,
    ...(buzz ? { buzz } : {}),
  };
}

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/** The agent's name, which names its bridge unit: given, then KYBERNESIS_AGENT, then the app folder. */
function agentName(appRoot: string, given: string | undefined, get: (key: string) => string | undefined): string | null {
  const name = given || get("KYBERNESIS_AGENT") || basename(appRoot);
  return AGENT_NAME.test(name) ? name : null;
}

/** Read once and kept: the key never changes under a file, and reading it runs the Buzz CLI. */
async function cachedBuzzIdentity(exec: Exec, appRoot: string, keyFile: string): Promise<{ npub: string; hex: string } | null> {
  const saved = readSetupState(appRoot).buzz;
  if (saved?.keyFile === keyFile && saved.npub && saved.hex && existsSync(keyFile)) return { npub: saved.npub, hex: saved.hex };
  const identity = await buzzIdentity(exec, appRoot, keyFile);
  if (identity) {
    writeSetupState(appRoot, (s) => {
      s.buzz = { ...s.buzz, keyFile, ...identity };
    });
  }
  return identity;
}

// ── Actions ────────────────────────────────────────────────────────────────

/** VNC reads only the first eight characters, so a longer password only looks stronger. */
export const VNC_PASSWORD = /^[A-Za-z0-9!#%+,.:=?@^_~-]{6,8}$/;

/** VNC reads only the first eight characters, so a longer password only looks stronger. */
export function vncPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** A phone number as E.164 (`+` and 7 to 15 digits), separators dropped; null when it is not one. */
export function e164(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const compact = input.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
}

/** The first JSON object in a CLI's output; CLIs print banners and notices around it. */
export function firstJson(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

const EMAIL = /^[^\s@"'`$\\]{1,64}@[^\s@"'`$\\]{1,190}\.[^\s@"'`$\\]{2,63}$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

type ActionResult = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string): ActionResult => ({ status, body: { ok: false, error } });

interface PendingClaudeLogin {
  id: string;
  child: ChildProcessWithoutNullStreams;
  timer: ReturnType<typeof setTimeout>;
}

export function createSetupActions(input: {
  appRoot: string;
  agent?: string;
  options: SetupOptions;
  restarter: SafeRestarter;
}) {
  const { appRoot, options, restarter } = input;
  const exec = options.exec ?? defaultExec;
  const start = options.start ?? defaultStart;
  const launch = options.launch ?? defaultLaunch;
  const envPath = join(appRoot, ".env.local");
  const linqCli = options.linqCli ?? LINQ_CLI;
  const computerName = options.computerName ?? process.env.COMPUTER_NAME ?? "agent-computer";
  const proxyName = options.claudeProxyName ?? process.env.CLAUDE_PROXY_NAME ?? `${basename(appRoot)}-claude-subscription`;
  const proxyPort = options.claudeProxyPort ?? (Number(process.env.CLAUDE_PROXY_PORT) || 3333);
  let claudeLogin: PendingClaudeLogin | undefined;

  const linq = (args: string[], timeoutMs = 120_000) =>
    exec("npx", ["--yes", linqCli, ...args], { cwd: appRoot, timeoutMs });

  const endClaudeLogin = () => {
    if (!claudeLogin) return;
    clearTimeout(claudeLogin.timer);
    if (claudeLogin.child.exitCode === null) claudeLogin.child.kill("SIGKILL");
    claudeLogin = undefined;
  };

  const actions: Record<string, (body: Record<string, unknown>) => Promise<ActionResult>> = {
    /**
     * A new password for the computer's screen: the owner's own (`password`,
     * 6 to 8 characters, since VNC reads only eight) or a generated one, shown once.
     *
     * The container keeps the password it was created with (x11vnc rewrites
     * its password file from the container's env at every start), so the
     * computer is removed and recreated at the safe restart. Its home and
     * /workspace are volumes: files and the signed-in browser survive that.
     */
    "vnc.password": async (body) => {
      if (!dependencies(appRoot).has("@kybernesis/computer")) return fail(409, "This agent has no computer.");
      if (!CONTAINER.test(computerName)) return fail(500, "The computer's container name is not usable.");
      const chosen = body.password;
      if (chosen !== undefined && (typeof chosen !== "string" || !VNC_PASSWORD.test(chosen))) {
        return fail(400, "Use 6 to 8 letters, digits or simple symbols; the screen reads only eight characters.");
      }
      const password = typeof chosen === "string" ? chosen : vncPassword();
      writeEnvFile(envPath, { set: { COMPUTER_VNC_PASSWORD: password }, unset: [] });
      writeSetupState(appRoot, (s) => {
        s.vnc = { rotatedAt: new Date((options.now ?? Date.now)()).toISOString() };
      });
      const restart = restarter.request(`docker rm -f ${computerName}`);
      return {
        status: 200,
        body: {
          ok: true,
          password,
          restart,
          note: "Shown once. The computer is recreated with it when the agent restarts; its files and signed-in browser are kept.",
        },
      };
    },

    /**
     * Sign the owner's Link wallet in on this host. Link's CLI starts a device
     * flow and returns the approval link and phrase at once; a detached poll
     * then completes it when the owner approves in the Link app. The payments
     * tools read the CLI's own file on every call, so no restart is needed.
     */
    "link.login": async () => {
      if (!dependencies(appRoot).has("@kybernesis/payments")) return fail(409, "This agent has no wallet installed.");
      const name = String(input.agent ?? "Agent").replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 64) || "Agent";
      // --no-install: an unscoped package called link-cli exists and is not Stripe's.
      const result = await exec("npx", ["--no-install", "link-cli", "auth", "login", "--client-name", name, "--format", "json"], {
        cwd: appRoot,
        timeoutMs: 60_000,
      });
      const out = firstJson(result.stdout) ?? firstJson(result.stderr);
      if (out?.authenticated === true) return { status: 200, body: { ok: true, state: "done", note: "The wallet is already signed in." } };
      const url = typeof out?.verification_url === "string" ? out.verification_url : null;
      const phrase = typeof out?.phrase === "string" ? out.phrase : null;
      if (result.code !== 0 || !url || !phrase) return fail(502, "Link did not start a sign-in. Try again in a minute.");
      launch(`npx --no-install link-cli auth status --interval 5 --timeout 600 --format json >/dev/null 2>&1`, appRoot);
      writeSetupState(appRoot, (s) => {
        s.link = { startedAt: new Date((options.now ?? Date.now)()).toISOString() };
      });
      return {
        status: 200,
        body: {
          ok: true,
          state: "approve",
          url,
          phrase,
          expiresInSeconds: 600,
          prompt: "Open the link, sign in to Link, and approve the request showing this phrase.",
        },
      };
    },

    /** Step one of an iMessage line: Linq emails the owner a six-digit code. */
    "linq.signup": async (body) => {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!EMAIL.test(email)) return fail(400, "email is required.");
      if (!publicUrlFor(options.publicUrl)) {
        return fail(409, "This agent has no public address for texts to reach (set EXE_VM_NAME or KYB_PUBLIC_URL).");
      }
      const env = readEnvFile(envPath);
      if (env.get("LINQ_API_KEY") && env.get("LINQ_WEBHOOK_SECRET")) return fail(409, "This agent already has an iMessage line.");
      const result = await linq(["signup", "--email", email]);
      const text = `${result.stdout}\n${result.stderr}`;
      if (/already logged in/i.test(text)) {
        return { status: 200, body: { ok: true, next: "linq.verify", codeRequired: false, prompt: "This agent is already signed in to Linq. Finish to connect its line." } };
      }
      if (/already have a Linq account/i.test(text)) {
        return fail(409, "That email already has a Linq account. Use another email for this agent's line.");
      }
      if (/lines are currently full/i.test(text)) return fail(503, "Linq has no lines free right now. Try again later.");
      if (result.code !== 0 || !/verification code/i.test(text)) return fail(502, "Linq did not send a code. Check the email and try again.");
      writeSetupState(appRoot, (s) => {
        s.linq = { email, at: new Date((options.now ?? Date.now)()).toISOString() };
      });
      return {
        status: 200,
        body: { ok: true, next: "linq.verify", codeRequired: true, prompt: `Enter the 6-digit code Linq emailed to ${email}.` },
      };
    },

    /**
     * Step two: the code in, the line out. Creates the account, points a
     * webhook at this agent, and stores the API key and webhook secret. The
     * CLI prints the API key on success, so its output is never returned.
     */
    "linq.verify": async (body) => {
      const saved = readSetupState(appRoot).linq;
      const email = (typeof body.email === "string" ? body.email.trim().toLowerCase() : saved?.email) ?? "";
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const name = (typeof body.name === "string" ? body.name.trim() : input.agent ?? "Agent").replace(/[^\p{L}\p{M}\p{N} .'-]/gu, "").slice(0, 80) || "Agent";
      const base = publicUrlFor(options.publicUrl);
      if (!base) return fail(409, "This agent has no public address for texts to reach (set EXE_VM_NAME or KYB_PUBLIC_URL).");

      if (code) {
        if (!/^\d{6}$/.test(code)) return fail(400, "code must be the 6 digits from the email.");
        if (!EMAIL.test(email)) return fail(400, "email is required (start with linq.signup).");
        const signup = await linq(["signup", "--email", email, "--code", code, "--name", name]);
        const text = `${signup.stdout}\n${signup.stderr}`;
        if (/lines are currently full/i.test(text)) return fail(503, "Linq has no lines free right now. Try again later.");
        if (signup.code !== 0 && !/already logged in/i.test(text)) {
          return fail(400, "Linq did not accept that code. Ask for a new one and try again.");
        }
      }

      const token = firstJson((await linq(["tokens", "show", "--json"])).stdout)?.token;
      if (typeof token !== "string" || !token) return fail(409, "Linq is not signed in on this host yet. Start with linq.signup.");
      const who = firstJson((await linq(["whoami", "--json"])).stdout);
      const number = typeof who?.phone === "string" && who.phone ? who.phone : null;

      // One webhook per agent: an earlier attempt's subscription is replaced,
      // because its signing secret is about to be overwritten.
      const target = `${base}/eve/v1/linq`;
      const listed = await linq(["webhooks", "list", "--json"]);
      const subs = parseList(listed.stdout);
      for (const sub of subs) {
        const url = sub.target_url ?? sub.url;
        if (url === target && typeof sub.id === "string") await linq(["webhooks", "delete", sub.id, "--json"]);
      }
      const created = firstJson((await linq(["webhooks", "create", "--url", target, "--events", LINQ_EVENTS, "--json"])).stdout);
      const secret = created?.signing_secret;
      if (typeof secret !== "string" || !secret) return fail(502, "Linq did not create the webhook for this agent. Try again.");

      writeEnvFile(envPath, { set: { LINQ_API_KEY: token, LINQ_WEBHOOK_SECRET: secret }, unset: [] });
      writeSetupState(appRoot, (s) => {
        s.linq = {
          email: email || s.linq?.email,
          ...(number ? { number } : {}),
          ...(typeof created?.id === "string" ? { webhookId: created.id } : {}),
          at: new Date((options.now ?? Date.now)()).toISOString(),
        };
      });
      const channel = channelFiles(appRoot).some((f) => /^linq\.(ts|js|mjs)$/.test(f));
      return {
        status: 200,
        body: {
          ok: true,
          number,
          channelInstalled: channel,
          restart: restarter.request(),
          ...(channel ? {} : { note: "The line is ready, but this agent has no Linq channel installed to answer it." }),
        },
      };
    },

    /**
     * Who can text the line. A shared line is inbound first: only the numbers
     * on its contact list reach it. A dedicated line takes texts from anyone,
     * so it has no list (`shared: false`).
     */
    "linq.contacts": async () => {
      const result = await linq(["contacts", "list", "--json"], 60_000);
      const text = `${result.stdout}\n${result.stderr}`;
      const number = readSetupState(appRoot).linq?.number ?? null;
      if (/Shared line accounts only/i.test(text)) return { status: 200, body: { ok: true, shared: false, number, contacts: [] } };
      if (/Not logged in|linq signup|linq login/i.test(text) && result.code !== 0) {
        return fail(409, "This agent has no iMessage line yet. Set one up first.");
      }
      const data = firstJson(result.stdout);
      if (result.code !== 0 || !data || !Array.isArray(data.contacts)) return fail(502, "Linq did not list the contacts. Try again.");
      const contacts = (data.contacts as Array<Record<string, unknown>>)
        .filter((c) => typeof c.contactPhone === "string")
        .map((c) => ({ phone: c.contactPhone as string, addedAt: typeof c.createdAt === "string" ? c.createdAt : null }));
      return { status: 200, body: { ok: true, shared: true, number, contacts } };
    },

    /** Let one more number text the shared line (E.164, like +12025551234). */
    "linq.contact.add": async (body) => {
      const phone = e164(body.phone);
      if (!phone) return fail(400, "phone must be a full number with its country code, like +12025551234.");
      const result = await linq(["contacts", "add", phone, "--json"], 60_000);
      const text = `${result.stdout}\n${result.stderr}`;
      if (/Shared line accounts only/i.test(text)) return fail(409, "This line takes texts from anyone, so it has no contact list.");
      const data = firstJson(result.stdout);
      if (result.code !== 0 || !data) return fail(502, /already/i.test(text) ? "That number is already on the list." : "Linq did not add that number. Try again.");
      return {
        status: 200,
        body: { ok: true, phone: typeof data.contactPhone === "string" ? data.contactPhone : phone, shareLink: typeof data.shareLink === "string" ? data.shareLink : null },
      };
    },

    /** Take a number off the shared line's contact list. */
    "linq.contact.remove": async (body) => {
      const phone = e164(body.phone);
      if (!phone) return fail(400, "phone must be a full number with its country code, like +12025551234.");
      const result = await linq(["contacts", "remove", phone, "--json"], 60_000);
      const text = `${result.stdout}\n${result.stderr}`;
      if (/Shared line accounts only/i.test(text)) return fail(409, "This line takes texts from anyone, so it has no contact list.");
      if (result.code !== 0) return fail(502, "Linq did not remove that number. Try again.");
      return { status: 200, body: { ok: true, phone } };
    },

    /**
     * Put the agent in its owner's Buzz community: `relay` is the community's
     * address (wss:// or https://, up to five), `name` and `picture` (https) are
     * how it appears there, defaulting to the agent's own name.
     *
     * Writes BUZZ_RELAY where the bridge and the agent both read it, publishes
     * the profile in every community that already counts the agent a member,
     * and switches the bridge on. Connecting again after an admin adds the key
     * publishes the profile where it could not before, without bouncing a
     * bridge that is already running for the same communities.
     */
    "buzz.join": async (body) => {
      if (!dependencies(appRoot).has("@kybernesis/buzz")) {
        return fail(409, "Buzz is not installed on this agent. Run kyb add buzz on its host.");
      }
      const env = readEnvFile(envPath);
      const get = (key: string) => env.get(key) || process.env[key];
      const agent = agentName(appRoot, input.agent, get);
      if (!agent) return fail(500, "This agent's name cannot name a bridge.");
      const parsed = parseRelays(body.relay ?? body.relays);
      if (!parsed.ok) return fail(400, parsed.error);
      const relays = parsed.relays;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : agent;
      if (name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) return fail(400, "name must be one line of at most 64 characters.");
      const picture = typeof body.picture === "string" ? body.picture.trim() : "";
      if (picture && !/^https:\/\/[^\s]{1,2040}$/.test(picture)) return fail(400, "picture must be an https:// address.");

      // One key for the bridge and the agent's tools. A key already in use is
      // kept: a new key is a member the community never invited.
      const legacy = buzzKeyFile(() => undefined);
      const keyFile = get("BUZZ_KEYFILE") || (existsSync(legacy) ? legacy : join(appRoot, ".buzz", "agent-key.json"));
      if (!existsSync(keyFile)) {
        mkdirSync(dirname(keyFile), { recursive: true });
        await exec("npx", ["kybernesis-buzz", "init"], { cwd: appRoot, timeoutMs: 60_000, env: { BUZZ_KEYFILE: keyFile } });
      }
      const identity = await cachedBuzzIdentity(exec, appRoot, keyFile);
      if (!identity) return fail(502, "Could not read the agent's Buzz key (npx kybernesis-buzz init).");

      const changed = writeEnvFile(envPath, { set: { BUZZ_RELAY: relays.join(","), BUZZ_KEYFILE: keyFile }, unset: [] });
      const profileArgs = ["kybernesis-buzz", "profile", "--name", name, ...(picture ? ["--picture", picture] : [])];
      const published = await exec("npx", profileArgs, {
        cwd: appRoot,
        timeoutMs: 90_000,
        env: { BUZZ_RELAY: relays.join(","), BUZZ_KEYFILE: keyFile },
      });
      const outcomes: RelayOutcome[] = parseProfileOutput(`${published.stdout}\n${published.stderr}`, relays);

      const unit = bridgeUnitName(agent);
      let bridge = await bridgeState(exec, appRoot, unit);
      if (bridge === "missing" && !(await installBridgeUnit(exec, appRoot, agent))) {
        return fail(502, `Could not install ${unit} on this host (it needs passwordless sudo).`);
      }
      const enabled = await exec("sudo", ["-n", "systemctl", "enable", unit], { cwd: appRoot, timeoutMs: 30_000 });
      if (enabled.code !== 0) return fail(502, `Could not switch on ${unit} (it needs passwordless sudo).`);
      // A running bridge read its communities at start; only new ones need it back.
      if (changed.length || bridge !== "active") {
        await exec("sudo", ["-n", "systemctl", "restart", unit], { cwd: appRoot, timeoutMs: 30_000 });
      }
      bridge = await bridgeState(exec, appRoot, unit);

      const members = outcomes.filter((o) => o.member).map((o) => o.url);
      writeSetupState(appRoot, (s) => {
        s.buzz = { ...s.buzz, keyFile, ...identity, relays, members, at: new Date((options.now ?? Date.now)()).toISOString() };
      });
      const waiting = outcomes.filter((o) => !o.member).map((o) => o.url.replace(/^wss:\/\//, ""));
      return {
        status: 200,
        body: {
          ok: true,
          npub: identity.npub,
          hex: identity.hex,
          relays: outcomes,
          bridge,
          // The agent's tools read BUZZ_RELAY at start, so it restarts only when that changed.
          restart: changed.length ? restarter.request() : { ...restarter.state(), note: "Nothing changed." },
          next: waiting.length
            ? `An admin of ${waiting.join(", ")} adds ${identity.npub} as a member and to the channels it should be in, then connect again to publish its name.`
            : "Connected. Mention it in any channel it has been added to.",
        },
      };
    },

    /** Take the agent out of Buzz: the bridge stops and stays off, the key is kept for next time. */
    "buzz.leave": async () => {
      const env = readEnvFile(envPath);
      const get = (key: string) => env.get(key) || process.env[key];
      const agent = agentName(appRoot, input.agent, get);
      if (!agent) return fail(500, "This agent's name cannot name a bridge.");
      const unit = bridgeUnitName(agent);
      if ((await bridgeState(exec, appRoot, unit)) !== "missing") {
        const off = await exec("sudo", ["-n", "systemctl", "disable", "--now", unit], { cwd: appRoot, timeoutMs: 30_000 });
        if (off.code !== 0) return fail(502, `Could not switch off ${unit} (it needs passwordless sudo).`);
      }
      const changed = writeEnvFile(envPath, { set: {}, unset: ["BUZZ_RELAY"] });
      writeSetupState(appRoot, (s) => {
        if (s.buzz) s.buzz = { ...s.buzz, relays: [], members: [] };
      });
      return {
        status: 200,
        body: {
          ok: true,
          bridge: await bridgeState(exec, appRoot, unit),
          restart: changed.length ? restarter.request() : { ...restarter.state(), note: "Nothing changed." },
        },
      };
    },

    /**
     * Sign a Claude subscription in to this host's loopback proxy.
     *
     * Two calls, because Claude's sign-in ends with a code the person copies
     * from the browser. The first starts `claude auth login` inside the proxy
     * container and returns its link; the CLI waits on stdin. The second hands
     * it the code on stdin (never argv), restarts the proxy, which reads
     * credentials only at startup, and asks the API whether the sign-in
     * actually authenticates.
     */
    "claude.login": async (body) => {
      if (!CONTAINER.test(proxyName)) return fail(500, "The subscription proxy's container name is not usable.");
      const code = typeof body.code === "string" ? body.code.trim() : "";

      if (code) {
        if (!claudeLogin || body.login !== claudeLogin.id) {
          return fail(409, "No sign-in is waiting for a code. Start again with claude.login.");
        }
        if (!/^[A-Za-z0-9#._~-]{8,512}$/.test(code)) return fail(400, "That does not look like a Claude sign-in code.");
        const pending = claudeLogin;
        clearTimeout(pending.timer);
        const exited = new Promise<number | null>((resolve) => {
          if (pending.child.exitCode !== null) resolve(pending.child.exitCode);
          pending.child.once("exit", (c) => resolve(c));
        });
        pending.child.stdin.write(`${code}\n`);
        let waited: ReturnType<typeof setTimeout> | undefined;
        const exitCode = await Promise.race([exited, new Promise<"timeout">((r) => (waited = setTimeout(() => r("timeout"), 60_000)))]);
        clearTimeout(waited);
        claudeLogin = undefined;
        if (exitCode !== 0) {
          if (pending.child.exitCode === null) pending.child.kill("SIGKILL");
          return fail(400, "Claude did not accept that code. Start again with claude.login.");
        }
        await exec("docker", ["restart", proxyName], { cwd: appRoot, timeoutMs: 60_000 });
        let state: Awaited<ReturnType<typeof subscriptionState>> = "not-running";
        for (let i = 0; i < 6 && state !== "signed-in"; i++) {
          await new Promise((r) => setTimeout(r, i === 0 ? 3000 : 2000));
          state = await subscriptionState(proxyPort);
        }
        if (state !== "signed-in") return fail(502, "Signed in, but the subscription is not authenticating yet. Try again.");
        const fileEnv = readEnvFile(join(appRoot, ".env.local"));
        const reachState = readModelReach(appRoot, (key) => fileEnv.get(key) || process.env[key]);
        const reach = reachState.reach;
        return {
          status: 200,
          body: {
            ok: true,
            state: "done",
            agentUsesSubscription: reach === "claude-sub",
            ...(reach === "claude-sub"
              ? {}
              : {
                  note:
                    `The subscription is signed in, but this agent still reaches its model through ${REACH_WORDS[reach]}.` +
                    (reachState.switchable ? ` Set ${MODEL_REACH_ENV}=claude-sub to use it.` : ""),
                }),
          },
        };
      }

      const running = await exec("docker", ["ps", "-q", "-f", `name=^${proxyName}$`], { cwd: appRoot, timeoutMs: 20_000 });
      if (!running.stdout.trim()) {
        const script = [join(appRoot, "scripts", "claude-subscription.sh"), join(appRoot, "node_modules", "@kybernesis", "exe", "scripts", "claude-subscription.sh")].find(
          (p) => existsSync(p),
        );
        if (!script) return fail(409, "This agent has no Claude subscription proxy installed.");
        const up = await exec("bash", [script, "up"], {
          cwd: appRoot,
          timeoutMs: 300_000,
          env: { CLAUDE_PROXY_NAME: proxyName, CLAUDE_PROXY_PORT: String(proxyPort) },
        });
        if (up.code !== 0) return fail(502, "The subscription proxy did not start on this host.");
      }

      endClaudeLogin();
      const child = start("docker", ["exec", "-i", proxyName, "claude", "auth", "login", "--claudeai"], { cwd: appRoot });
      const url = await new Promise<string | null>((resolve) => {
        let seen = "";
        const onData = (d: Buffer) => {
          seen += d.toString();
          const match = /https:\/\/\S*oauth\/authorize\?\S+/.exec(seen);
          if (match) finish(match[0]);
        };
        const timer = setTimeout(() => finish(null), 30_000);
        const finish = (value: string | null) => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.stderr.off("data", onData);
          resolve(value);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("exit", () => finish(null));
      });
      if (!url) {
        if (child.exitCode === null) child.kill("SIGKILL");
        return fail(502, "Claude did not start a sign-in on this host.");
      }
      const id = randomBytes(12).toString("base64url");
      const timer = setTimeout(endClaudeLogin, CLAUDE_LOGIN_TTL_MS);
      timer.unref?.();
      claudeLogin = { id, child, timer };
      return {
        status: 200,
        body: {
          ok: true,
          state: "code",
          url,
          login: id,
          expiresInSeconds: CLAUDE_LOGIN_TTL_MS / 1000,
          prompt: "Open the link, choose your Claude account, then paste the code it shows.",
        },
      };
    },
  };

  return {
    names: Object.keys(actions),
    async run(body: Record<string, unknown>): Promise<ActionResult> {
      const name = typeof body.action === "string" ? body.action : "";
      const action = actions[name];
      if (!action) return fail(400, `Unknown action. Available: ${Object.keys(actions).join(", ")}.`);
      return action(body);
    },
  };
}

function parseList(text: string): Array<Record<string, unknown> & { id?: unknown; target_url?: unknown; url?: unknown }> {
  const start = text.search(/[[{]/);
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(text.slice(start)) as unknown;
    const list = Array.isArray(parsed) ? parsed : ((parsed as { data?: unknown }).data ?? (parsed as { subscriptions?: unknown }).subscriptions);
    return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

export function setupRoutes(input: {
  prefix: string;
  appRoot: string;
  agent?: string;
  restartCommand?: string;
  options: SetupOptions;
  writable: () => { ok: true } | { ok: false; reason: string };
  /** Must admit only a `manage` grant on this agent. */
  authorize: (req: Request) => Promise<Response | null>;
}): RouteDefinition[] {
  const prefix = `${input.prefix}/setup`;
  const restarter =
    input.options.restarter ??
    new SafeRestarter({ appRoot: input.appRoot, restartCommand: input.restartCommand, launch: input.options.launch, now: input.options.now });
  const actions = createSetupActions({ appRoot: input.appRoot, agent: input.agent, options: input.options, restarter });

  return [
    GET(prefix, async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      const writable = input.writable();
      const status = await setupStatus({
        appRoot: input.appRoot,
        agent: input.agent,
        options: input.options,
        restarter,
        restartCommand: input.restartCommand,
      });
      return Response.json({
        ok: true,
        writable: writable.ok,
        reason: writable.ok ? null : writable.reason,
        actions: actions.names,
        ...status,
      });
    }),

    POST(`${prefix}/env`, async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      const checked = validateEnvUpdate(await req.json().catch(() => ({})));
      if (!checked.ok) return Response.json({ ok: false, error: checked.error }, { status: 400 });
      const writable = input.writable();
      if (!writable.ok) return Response.json({ ok: false, error: writable.reason }, { status: 409 });
      const changed = writeEnvFile(join(input.appRoot, ".env.local"), checked.update);
      // Unchanged values need no restart: re-saving a form must not bounce the agent.
      const restart = changed.length ? restarter.request() : { ...restarter.state(), note: "Nothing changed." };
      return Response.json({ ok: true, changed, restart });
    }),

    POST(`${prefix}/action`, async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      const writable = input.writable();
      if (!writable.ok) return Response.json({ ok: false, error: writable.reason }, { status: 409 });
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await actions.run(body && typeof body === "object" ? body : {});
      return Response.json(result.body, { status: result.status });
    }),
  ];
}
