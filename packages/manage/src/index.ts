import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { verifyKybernesisRequest } from "@kybernesis/enterprise";
import { card, describeCron, forModel, nextCronRun, withCards } from "@kybernesis/cards";
import { defineChannel, GET, POST } from "eve/channels";
import { routineOwner, routineSource } from "./routine-source.js";
import { listSessions } from "./sessions.js";
import { threadRoutes } from "./thread-routes.js";
import {
  AGENT_OWNER,
  captureRunEvent,
  newRunCapture,
  runAddress,
  runCards,
  threadOwnerOf,
  threadsDir,
  updateThread,
  type RunCapture,
} from "./thread.js";

/** What a session on this channel is: a person's thread, a background run, or something older. */
type KybState = { kind: "thread" | "run" | "other"; owner?: string; routine?: string };
import { computerRoutes, type ComputerOptions } from "./computer.js";
import { setupRoutes, type SetupOptions } from "./setup.js";
import { memoryRoutes, type MemoryOptions } from "./memory.js";
import { artifactRoutes, type ArtifactsOptions, type ArtifactViewer } from "./artifacts.js";
import { screenRoutes, type ScreensOptions } from "./screens.js";
import { fileRoutes, type FilesOptions } from "./files.js";

/**
 * Management routes, so a client can actually CHANGE an agent.
 *
 * eve's `/eve/v1/info` reports what an agent has; nothing lets you add to it.
 * That gap is why a console ends up with buttons that cannot work. This channel
 * closes it: install a registry item, write a schedule, rebuild, restart.
 *
 * The honest shape of this is that an agent edits its own repository and
 * redeploys. On a VM or any host with a working copy that is exactly what
 * happens here. On a read-only serverless deployment it cannot, and the routes
 * say so rather than reporting a success that will vanish on the next deploy.
 *
 * ```ts title="agent/channels/kyb.ts"
 * import { manageChannel } from "@kybernesis/manage";
 * export default manageChannel({ restartCommand: "bash ~/restart.sh" });
 * ```
 */

/**
 * Routes mount verbatim at the server root, so they are namespaced here rather
 * than left as bare words like /install sitting beside the agent own API.
 */
const PREFIX = "/eve/v1/kyb";

/**
 * How long to wait before restarting after a change.
 *
 * The restart is what makes a new routine or capability live, and it also kills
 * whatever turn is in flight — including the turn that asked for it. Long enough
 * for the agent to finish telling the user what it did; short enough that the
 * change is live before they act on it.
 */
const RESTART_DELAY_MS = 20_000;
/** From saving a routine to its schedule being live: the wait, a build, the restart delay, and the restart's own build. */
const LIVE_AFTER_MS = 150_000;

/**
 * The address of the agent's one conversation with its person.
 *
 * Fixed, because both sides have to name it without coordinating: routines
 * deliver here, and the client asks for it by calling /session. A per-routine
 * address would give every routine its own thread, which is exactly the
 * behaviour that made routines look broken — they ran, and their answers piled
 * up somewhere nobody opens.
 */
const CANONICAL_ADDRESS = "studio";

/** Where the canonical session id is published for clients to adopt. */
function canonicalSessionFile(appRoot: string): string {
  return join(appRoot, ".eve", "canonical-session.json");
}

/**
 * Record which session the canonical address currently resolves to.
 *
 * Written on delivery rather than derived on request: only the send knows the
 * id, and a client asking later must get the same answer without starting a
 * turn of its own to find out.
 */
export function rememberCanonicalSession(appRoot: string, sessionId: string, routine: string): void {
  // An eval run delivers routines too, into throwaway sessions. Recording one
  // of those as THE conversation pointed every Studio at an eval probe's
  // thread (Kyber, 2026-10-06: "PROBE OK." from a September eval). kyb-eval
  // sets this; nothing in production does.
  if (process.env.KYB_CANONICAL_SESSION === "off") return;
  try {
    const file = canonicalSessionFile(appRoot);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessionId, lastRoutine: routine, at: new Date().toISOString() }), "utf8");
    renameSync(tmp, file);
  } catch {
    // A routine that delivered must not fail because a pointer could not be
    // written; the client simply keeps the session it already had.
  }
}

/**
 * The canonical session id, or undefined before any routine has delivered —
 * or after the run behind it died.
 *
 * A pointer at a dead run is worse than none: the client adopts it on every
 * refresh, the adopted thread cannot take a turn, the client starts a fresh
 * one, and the next refresh adopts the dead one again. That is the "answers,
 * then flips to an old conversation" Kyber showed after the eve 0.68 restart
 * replayed and failed a run from September. The run store says whether a run
 * is still alive; a failed or missing one retires the pointer here.
 */
export function readCanonicalSession(appRoot: string): { sessionId: string; lastRoutine?: string; at?: string } | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(canonicalSessionFile(appRoot), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId === "") return undefined;
  if (!runIsAlive(appRoot, raw.sessionId)) {
    try {
      renameSync(canonicalSessionFile(appRoot), `${canonicalSessionFile(appRoot)}.retired`);
    } catch {
      /* nothing to retire, or read-only: the undefined below is the point */
    }
    return undefined;
  }
  return {
    sessionId: raw.sessionId,
    ...(typeof raw.lastRoutine === "string" ? { lastRoutine: raw.lastRoutine } : {}),
    ...(typeof raw.at === "string" ? { at: raw.at } : {}),
  };
}

/**
 * Whether eve's local run store still considers a durable run continuable.
 * No store (a hosted deployment keeps runs elsewhere) means "assume alive":
 * only a record that SAYS the run ended is evidence.
 */
export function runIsAlive(appRoot: string, sessionId: string): boolean {
  const runsDir = join(appRoot, ".eve", ".workflow-data", "runs");
  if (!existsSync(runsDir)) return true;
  const file = join(runsDir, `${sessionId}.json`);
  if (!existsSync(file)) return false;
  try {
    const run = JSON.parse(readFileSync(file, "utf8")) as { status?: unknown };
    return run.status !== "failed" && run.status !== "completed" && run.status !== "cancelled";
  } catch {
    return true;
  }
}


/**
 * Custom channels do NOT run the eve channel's authenticator, so these routes
 * must verify identity themselves. They verify the SAME control-plane identity
 * the user already signed in with — not a separate key.
 *
 * An earlier version invented a shared secret for this. It was wrong: the user
 * would have had to read it out of the agent's env file and paste it into a
 * client, which is a workaround with a password box rather than authentication,
 * and it bypassed the grants that govern every other door into this agent.
 */
async function authorize(req: Request, options: ManageOptions, level: "use" | "manage" = "use"): Promise<Response | null> {
  const issuer = options.issuer ?? process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai";
  const agent = options.agent ?? process.env.KYBERNESIS_AGENT;
  if (!agent) {
    return Response.json(
      { ok: false, error: "This agent has no KYBERNESIS_AGENT set, so it cannot check grants." },
      { status: 500 },
    );
  }
  const result = await verifyKybernesisRequest(req, { issuer, agent });
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
  // Setup writes secrets and restarts the agent: talking to it is not enough.
  if (level === "manage" && result.principal.level !== "manage") {
    return Response.json(
      { ok: false, error: `Setting up "${agent}" needs manage access; you can use it but not change it.` },
      { status: 403 },
    );
  }
  return null;
}

/**
 * The same check as `authorize`, for routes that answer differently per person:
 * the verified caller, or the Response that refuses them.
 */
async function identify(req: Request, options: ManageOptions): Promise<(ArtifactViewer & { org?: string; email?: string }) | Response> {
  const issuer = options.issuer ?? process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai";
  const agent = options.agent ?? process.env.KYBERNESIS_AGENT;
  if (!agent) {
    return Response.json(
      { ok: false, error: "This agent has no KYBERNESIS_AGENT set, so it cannot check grants." },
      { status: 500 },
    );
  }
  const result = await verifyKybernesisRequest(req, { issuer, agent });
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
  return { userId: result.principal.userId, level: result.principal.level, org: result.principal.org, email: result.principal.email };
}

export interface ManageOptions {
  /**
   * The module name of this channel under `agent/channels/`, without extension.
   * A routine created from Studio imports it to deliver its answer, so it must
   * match the real filename. Defaults to "kyb".
   */
  channelModule?: string;
  /** Repo root. Defaults to the process working directory. */
  appRoot?: string;
  /**
   * How to restart the server after a change. Without it, a successful install
   * is reported as "restart required" rather than as done — a change the
   * running process has not picked up is not finished, and saying otherwise is
   * the whole problem this package exists to avoid.
   */
  restartCommand?: string;
  /** Registry to install from. Defaults to the Kybernesis registry. */
  registry?: string;
  /** Control-plane issuer. Defaults to KYBERNESIS_ISSUER. */
  issuer?: string;
  /** This agent's registered name. Defaults to KYBERNESIS_AGENT. */
  agent?: string;
  /** Where the surfaces on this host declare themselves. Defaults to KYB_SURFACES_DIR, then ~/.kybernesis/surfaces. */
  surfacesDir?: string;
  /**
   * The agent's computer (@kybernesis/computer), for signed-in clients: a
   * ticketed WebSocket relay to its screen under /eve/v1/kyb/computer. On by
   * default; the routes report no computer when nothing listens on the port.
   */
  computer?: ComputerOptions | false;
  /**
   * Setup routes under /eve/v1/kyb/setup, for an owner's client: setup status,
   * allowlisted env values (model reach, Slack), and the steps that used to
   * need a terminal on the host (Claude subscription sign-in, iMessage line,
   * Link wallet, the computer's screen password). Owner-only (a `manage`
   * grant). On by default.
   */
  setup?: SetupOptions | false;
  /**
   * Memory routes under /eve/v1/kyb/memory, for an owner's client: search,
   * recent, recall one entity, remember or correct, pin. Read with the agent's
   * own workspace key from its environment. Owner-only (a `manage` grant). On
   * by default; they answer 404 when the agent has no memory configured.
   */
  memory?: MemoryOptions | false;
  /**
   * Files the agent delivered (the engineer's `deliver` tool), served under
   * /eve/v1/kyb/files/<id>/<name>. Public by link: the id is 128 random bits
   * and nothing lists the directory. On by default; answers 404 for anything
   * that was not delivered.
   */
  files?: FilesOptions | false;
  /**
   * Artifacts the agent made (`@kybernesis/artifacts`), under
   * /eve/v1/kyb/artifacts: list, one artifact's versions, and its content as
   * text for the app's sandbox. Each caller sees only their own artifacts; one
   * nobody owns is shown to people who manage the agent. On by default; an
   * agent without the package simply has none.
   */
  artifacts?: ArtifactsOptions | false;
  /**
   * Screenshots the agent showed someone (`show_screen`), under
   * /eve/v1/kyb/screens/<id>. Each caller sees only the ones taken for them;
   * one taken for nobody is shown to people who manage the agent. On by
   * default; an agent without a computer simply has none.
   */
  screens?: ScreensOptions | false;
  /**
   * One continuous conversation per person (see ./thread.ts): routes under
   * /eve/v1/kyb/thread, and routines run in the background and report into
   * their owner's thread. `dir` defaults to KYB_THREADS_DIR, then
   * ~/.kybernesis/threads. `false` keeps the old single routines conversation.
   */
  threads?: { dir?: string } | false;
}

/**
 * A surface is a way to reach this agent that eve does not know about.
 *
 * eve reports the channels the agent authored; a workspace bridge is a separate
 * process, and without this every console showed an agent that was answering in
 * a workspace all day as reachable "only through this app". Each bridge writes
 * a small manifest and touches it every minute (see @kybernesis/buzz's
 * surface.ts); this reads the directory back and says which are live. Three
 * missed heartbeats is dead, and the file says so rather than the row vanishing.
 */
export interface Surface {
  kind: string;
  name: string;
  /** Where it is connected, in a form a person recognises: relay hosts, a workspace name. */
  detail: string;
  live: boolean;
  heartbeatAt: string;
  conversations?: number;
}

const SURFACE_STALE_MS = 3 * 60_000;

export function readSurfaces(dir: string, now = Date.now()): Surface[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Surface[] = [];
  for (const f of files) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        kind?: unknown;
        name?: unknown;
        relays?: unknown;
        heartbeatAt?: unknown;
        conversations?: unknown;
      };
      if (typeof m.kind !== "string" || typeof m.heartbeatAt !== "string") continue;
      const relays = Array.isArray(m.relays) ? m.relays.filter((r): r is string => typeof r === "string") : [];
      const hosts = relays.map((r) => {
        try {
          return new URL(r).hostname;
        } catch {
          return r;
        }
      });
      out.push({
        kind: m.kind,
        name: typeof m.name === "string" ? m.name : m.kind,
        detail: hosts.join(", "),
        live: now - Date.parse(m.heartbeatAt) < SURFACE_STALE_MS,
        heartbeatAt: m.heartbeatAt,
        ...(typeof m.conversations === "number" ? { conversations: m.conversations } : {}),
      });
    } catch {
      /* not a manifest */
    }
  }
  return out;
}

interface RunResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

function run(command: string, cwd: string, timeoutMs = 300_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL ?? "/bin/bash", ["-lc", command], { cwd });
    let output = "";
    const cap = 60_000;
    const append = (d: Buffer): void => {
      if (output.length < cap) output += d.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, exitCode: null, output: `${output}\n\nTimed out after ${timeoutMs}ms.` });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, output: `${output}\n${String(e)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, output });
    });
  });
}

/** A repo we can actually modify, or a clear reason why not. */
function writableRoot(appRoot: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(join(appRoot, "package.json"))) {
    return {
      ok: false,
      reason:
        `No package.json at ${appRoot}. This agent is not running from a working copy it can ` +
        `modify — installing from a client needs a host with the repo present (a VM), not a ` +
        `read-only serverless bundle.`,
    };
  }
  try {
    const probe = join(appRoot, ".kyb-write-probe");
    writeFileSync(probe, "");
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: `${appRoot} is not writable by the agent process, so nothing can be installed here.`,
    };
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "schedule"
  );
}

export function manageChannel(options: ManageOptions = {}) {
  const appRoot = options.appRoot ?? process.cwd();
  const registry = options.registry ?? "https://registry.kybernesis.ai/r/registry.json";

  const surfacesDir = options.surfacesDir ?? process.env.KYB_SURFACES_DIR ?? join(homedir(), ".kybernesis", "surfaces");

  // Which file under agent/channels/ this channel is, so a scaffolded routine
  // can import it. Defaults to the name every kyb-scaffolded agent uses; an
  // agent that named the file something else says so rather than getting a
  // routine that fails to compile.
  const manageModule = options.channelModule ?? "kyb";

  const threads = options.threads === false ? null : threadsDir(options.threads?.dir);
  /** What each background run has produced so far, by session id. */
  const runs = new Map<string, RunCapture>();
  const captureFor = (id: string): RunCapture => {
    let c = runs.get(id);
    if (!c) runs.set(id, (c = newRunCapture()));
    return c;
  };
  const capture = (type: string) => (data: unknown, channel: { state: KybState }, ctx: { session: { id: string } }) => {
    if (channel.state.kind === "run") captureRunEvent(captureFor(ctx.session.id), type, data);
  };

  return defineChannel<KybState>({
    state: { kind: "other" },

    /**
     * Where a routine runs.
     *
     * A schedule reaches a channel through `to(channel, target)`. Each firing
     * gets its own background session at its own address, as eve intends a
     * scheduled job to work, and the instruction stays there. Nobody's
     * conversation takes a turn for it. When the run has an answer, the events
     * below add it to its owner's thread as a report (see ./thread.ts), and
     * notify rings their phone because the run is theirs.
     *
     * The earlier shape delivered every routine into one shared conversation,
     * so its instruction appeared there as if someone had typed it, and on a
     * company agent everyone's routines would have shared one thread.
     */
    receive: async ({ message, target, auth }, { from }) => {
      const routine = String((target as { routine?: unknown }).routine ?? "routine");
      if (!threads) {
        // Threads switched off: the old single conversation every client could adopt.
        const session = await from(CANONICAL_ADDRESS).send(message, { auth, turnPolicy: "queue", state: { kind: "other" } });
        rememberCanonicalSession(appRoot, session.id, routine);
        return session;
      }
      const owner = threadOwnerOf(auth) ?? AGENT_OWNER;
      return from(runAddress(routine, owner)).send(message, { auth, state: { kind: "run", owner, routine } });
    },

    events: {
      "actions.requested": capture("actions.requested"),
      "action.result": capture("action.result"),
      "task.started": capture("task.started"),
      "task.settled": capture("task.settled"),
      "message.completed": capture("message.completed"),

      // A run that stops to ask: the question goes into its owner's thread,
      // where they answer it (POST /thread/respond with the run's session id).
      "input.requested"(data: unknown, channel: { state: KybState }, ctx: { session: { id: string } }) {
        const { state } = channel;
        if (!threads || state.kind !== "run" || !state.owner) return;
        const requests = (data as { requests?: unknown }).requests;
        if (!Array.isArray(requests) || requests.length === 0) return;
        const prompt = (requests[0] as { prompt?: unknown }).prompt;
        updateThread(threads, state.owner, (r) => {
          r.reports.push({
            id: `${ctx.session.id}:${r.reports.length}`,
            kind: "question",
            routine: state.routine ?? "routine",
            text: typeof prompt === "string" ? prompt : "",
            at: new Date().toISOString(),
            runSessionId: ctx.session.id,
            requests,
          });
        });
      },

      // The run's turn ended: its last answer and its cards become the report.
      // A run that said nothing (no_reply) adds nothing.
      "session.waiting"(_data: unknown, channel: { state: KybState }, ctx: { session: { id: string } }) {
        const { state } = channel;
        if (!threads || state.kind !== "run" || !state.owner) return;
        const run = runs.get(ctx.session.id);
        runs.delete(ctx.session.id);
        const text = run?.text ?? "";
        const cards = run ? runCards(run) : [];
        updateThread(threads, state.owner, (r) => {
          for (const q of r.reports) if (q.runSessionId === ctx.session.id && q.kind === "question") q.settled = true;
          if (!text && cards.length === 0) return;
          r.reports.push({
            id: `${ctx.session.id}:${r.reports.length}`,
            kind: "report",
            routine: state.routine ?? "routine",
            text,
            ...(cards.length ? { cards } : {}),
            at: new Date().toISOString(),
            runSessionId: ctx.session.id,
          });
        });
      },

      // A run that failed for good reports nothing; its open questions close.
      "session.failed"(_data: unknown, channel: { state: KybState }, ctx: { session: { id: string } }) {
        runs.delete(ctx.session.id);
        const { state } = channel;
        if (!threads || state.kind !== "run" || !state.owner) return;
        updateThread(threads, state.owner, (r) => {
          for (const q of r.reports) if (q.runSessionId === ctx.session.id && q.kind === "question") q.settled = true;
        });
      },
    } as never,
    // Routes take no channel state; the generic only types the sessions this channel starts.
    routes: ([
      ...(threads
        ? threadRoutes({
            prefix: PREFIX,
            dir: threads,
            issuer: options.issuer ?? process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai",
            identify: (req) => identify(req, options),
            schedulesDir: join(appRoot, "agent/schedules"),
          })
        : []),
      ...(options.computer === false
        ? []
        : computerRoutes({ prefix: PREFIX, options: options.computer ?? {}, authorize: (req) => authorize(req, options) })),
      ...(options.files === false ? [] : fileRoutes({ prefix: PREFIX, options: options.files ?? {} })),
      ...(options.artifacts === false
        ? []
        : artifactRoutes({ prefix: PREFIX, options: options.artifacts ?? {}, identify: (req) => identify(req, options) })),
      ...(options.screens === false
        ? []
        : screenRoutes({ prefix: PREFIX, options: options.screens ?? {}, identify: (req) => identify(req, options) })),
      ...(options.memory === false
        ? []
        : memoryRoutes({ prefix: PREFIX, options: options.memory ?? {}, authorize: (req) => authorize(req, options, "manage") })),
      ...(options.setup === false
        ? []
        : setupRoutes({
            prefix: PREFIX,
            appRoot,
            agent: options.agent ?? process.env.KYBERNESIS_AGENT,
            restartCommand: options.restartCommand,
            options: {
              ...(options.computer ? { computerName: options.computer.name } : {}),
              ...options.setup,
            },
            writable: () => writableRoot(appRoot),
            authorize: (req) => authorize(req, options, "manage"),
          })),
      /**
       * The conversation this agent considers canonical.
       *
       * A client asks once and adopts it, so what a routine says and what the
       * person types land in the same thread. Without this each side keeps its
       * own session and routines appear to do nothing — they ran, they just ran
       * somewhere nobody opens.
       *
       * Absent until a routine has actually delivered, which is deliberate: a
       * client must not abandon a live conversation to adopt one that does not
       * exist yet.
       */
      GET(PREFIX + "/session", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        const canonical = readCanonicalSession(appRoot);
        return Response.json({ session: canonical ?? null });
      }),

      /**
       * Every conversation this agent has had, most recent first, with the
       * surface it came from and whether it can still take a turn. The list a
       * person never had: Studio adopted one session, the phone knew the one a
       * notification named, and iMessage threads, Buzz rooms and old chats sat
       * on disk unlisted. `?limit=` (default 50), `?alive=1` for live ones only.
       */
      GET(PREFIX + "/sessions", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        const url = new URL(req.url);
        const limit = Number(url.searchParams.get("limit") ?? "50") || 50;
        const aliveOnly = url.searchParams.get("alive") === "1";
        const canonical = readCanonicalSession(appRoot);
        const sessions = listSessions(appRoot, { canonicalId: canonical?.sessionId, limit, includeEnded: !aliveOnly });
        return Response.json({ sessions, routines: canonical?.sessionId ?? null });
      }),

      // The ways to reach this agent that eve does not list: workspace bridges on this host.
      GET(PREFIX + "/surfaces", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        return Response.json({ surfaces: readSurfaces(surfacesDir) });
      }),

      // What can be installed, and what already is.
      GET(PREFIX + "/catalog", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        const res = await fetch(registry, { signal: AbortSignal.timeout(20_000) }).catch(
          () => null,
        );
        const catalog = res?.ok ? await res.json().catch(() => null) : null;

        let installed: string[] = [];
        try {
          const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
          };
          installed = Object.keys(pkg.dependencies ?? {});
        } catch {
          /* reported as empty below */
        }

        const writable = writableRoot(appRoot);
        return Response.json({
          catalog,
          installed,
          writable: writable.ok,
          reason: writable.ok ? null : writable.reason,
        });
      }),

      // Install a registry item: files, dependencies, and env template.
      /**
       * Install a control-plane credential this agent needs to identify itself.
       *
       * The alternative is a person copying a secret out of an admin UI and
       * pasting it into a deployment's env file, and nobody should be asked to
       * do that — not a client, not an operator, not us. KYBER Studio is signed
       * in as the owner, mints the credential from the control plane, and
       * installs it here over the same authenticated channel. No human sees the
       * value at any point.
       *
       * Deliberately NOT a general env-write route. That would be a way to set a
       * model provider key, a webhook secret, anything at all — one
       * authenticated bug away from being the most dangerous route in the agent.
       * Only keys that identify the agent to the control plane are accepted, and
       * no value is ever read back out.
       */
      POST(PREFIX + "/credential", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as { key?: string; value?: string };
        const ALLOWED = new Set(["KYBERNESIS_AGENT_CREDENTIAL"]);
        if (!body.key || !ALLOWED.has(body.key)) {
          return Response.json(
            { ok: false, error: `Only ${[...ALLOWED].join(", ")} may be set here.` },
            { status: 400 },
          );
        }
        if (!body.value || body.value.length < 20) {
          return Response.json({ ok: false, error: "value is required" }, { status: 400 });
        }

        const writable = writableRoot(appRoot);
        if (!writable.ok) return Response.json({ ok: false, error: writable.reason }, { status: 409 });

        const envPath = join(appRoot, ".env.local");
        const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
        const line = `${body.key}=${JSON.stringify(body.value)}`;
        const existing = new RegExp(String.raw`^${body.key}=.*`, "m");
        const next = existing.test(current)
          ? current.replace(existing, line)
          : `${current.trimEnd()}\n${line}\n`;
        writeFileSync(envPath, next, { mode: 0o600 });

        // A credential is read from the environment at boot, so it does nothing
        // until the process restarts. Reporting success without that would be
        // reporting a change the agent is not yet using.
        if (options.restartCommand) {
          setTimeout(() => {
            spawn(process.env.SHELL ?? "/bin/bash", ["-lc", options.restartCommand!], {
              cwd: appRoot,
              detached: true,
              stdio: "ignore",
            }).unref();
          }, RESTART_DELAY_MS);
        }

        return Response.json({
          ok: true,
          key: body.key,
          restarted: Boolean(options.restartCommand),
          note: options.restartCommand
            ? "Stored. The agent is restarting to pick it up."
            : "Stored. It takes effect at the next restart.",
        });
      }),

      POST(PREFIX + "/install", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as { item?: string };
        if (!body.item) return Response.json({ ok: false, error: "item is required" }, { status: 400 });

        const writable = writableRoot(appRoot);
        if (!writable.ok) return Response.json({ ok: false, error: writable.reason }, { status: 409 });

        // `eve add` owns the whole recipe — files, deps, env keys — so a client
        // never has to reimplement it and drift from what the CLI does. The
        // catalog names items bare ("vault"); eve resolves a bare name against
        // ITS registry and answers with a listing of ours, which Studio then
        // showed as the error (Kyber, 2026-10-07). Scope it here.
        const install = await run(`npx --yes eve add ${JSON.stringify(registryItemRef(body.item))} --yes`, appRoot);
        if (!install.ok) {
          return Response.json({ ok: false, step: "install", output: install.output }, { status: 500 });
        }

        const build = await run("npx eve build", appRoot);
        if (!build.ok) {
          return Response.json(
            {
              ok: false,
              step: "build",
              output: build.output,
              note: "Installed, but the agent did not rebuild — it is still serving the previous build.",
            },
            { status: 500 },
          );
        }

        if (!options.restartCommand) {
          return Response.json({
            ok: true,
            restarted: false,
            output: install.output,
            note: "Installed and rebuilt. A restart is still required before the agent uses it.",
          });
        }

        // Restart detached, AFTER responding: the process serving this request
        // is the one being replaced, so awaiting it would kill the answer.
        setTimeout(() => {
          spawn(process.env.SHELL ?? "/bin/bash", ["-lc", options.restartCommand!], {
            cwd: appRoot,
            detached: true,
            stdio: "ignore",
          }).unref();
        }, RESTART_DELAY_MS);

        return Response.json({
          ok: true,
          restarted: true,
          output: install.output,
          note: "Installed. The agent is restarting and will be briefly unavailable.",
        });
      }),

      // Write a schedule into the repo. eve discovers agent/schedules/*.ts.
      POST(PREFIX + "/schedule", async (req) => {
        const caller = await identify(req, options);
        if (caller instanceof Response) return caller;
        const body = (await req.json().catch(() => ({}))) as {
          name?: string;
          cron?: string;
          instruction?: string;
        };
        if (!body.name || !body.cron || !body.instruction) {
          return Response.json(
            { ok: false, error: "name, cron, and instruction are required" },
            { status: 400 },
          );
        }

        const writable = writableRoot(appRoot);
        if (!writable.ok) return Response.json({ ok: false, error: writable.reason }, { status: 409 });

        const slug = slugify(body.name);
        const file = join(appRoot, "agent/schedules", `${slug}.ts`);
        if (existsSync(file)) {
          return Response.json(
            { ok: false, error: `A schedule named "${slug}" already exists.` },
            { status: 409 },
          );
        }

        // Authored as source, because that is what it is: the repository stays
        // the truth, and this file is reviewable and revertable like any other.
        const source = routineSource({
          name: slug,
          cron: body.cron,
          instruction: body.instruction,
          manageChannelModule: manageModule,
          // It runs as whoever made it in Studio: their calendar, their pages, their phone.
          owner: routineOwner(
            {
              authenticator: "kybernesis",
              issuer: options.issuer ?? process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai",
              principalId: caller.userId,
              principalType: "user",
              subject: caller.userId,
              attributes: {
                ...(caller.org ? { org: caller.org } : {}),
                ...(caller.email ? { email: caller.email } : {}),
                agentGrantLevel: caller.level,
              },
            },
            slug,
          ),
        });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source, "utf8");

        const build = await run("npx eve build", appRoot);
        if (!build.ok) {
          return Response.json(
            { ok: false, step: "build", output: build.output, file: `agent/schedules/${slug}.ts` },
            { status: 500 },
          );
        }

        if (options.restartCommand) {
          setTimeout(() => {
            spawn(process.env.SHELL ?? "/bin/bash", ["-lc", options.restartCommand!], {
              cwd: appRoot,
              detached: true,
              stdio: "ignore",
            }).unref();
          }, RESTART_DELAY_MS);
        }

        return Response.json({
          ok: true,
          file: `agent/schedules/${slug}.ts`,
          restarted: Boolean(options.restartCommand),
        });
      }),

      // Remove a schedule this agent owns.
      POST(PREFIX + "/schedule/delete", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as { name?: string };
        if (!body.name) return Response.json({ ok: false, error: "name is required" }, { status: 400 });

        const dir = join(appRoot, "agent/schedules");
        if (!existsSync(dir)) return Response.json({ ok: false, error: "no schedules" }, { status: 404 });

        const slug = slugify(body.name);
        const match = readdirSync(dir).find((f) => f === `${slug}.ts`);
        if (!match) {
          return Response.json({ ok: false, error: `No schedule file for "${body.name}".` }, { status: 404 });
        }

        // Renamed rather than deleted: this is the user's repository, and an
        // undo should not require a client to have kept a copy.
        const trash = join(appRoot, ".kyb-trash/schedules");
        mkdirSync(trash, { recursive: true });
        writeFileSync(join(trash, `${slug}.ts`), readFileSync(join(dir, match), "utf8"), "utf8");
        await run(`rm -f ${JSON.stringify(join(dir, match))}`, appRoot);

        const build = await run("npx eve build", appRoot);
        if (options.restartCommand && build.ok) {
          setTimeout(() => {
            spawn(process.env.SHELL ?? "/bin/bash", ["-lc", options.restartCommand!], {
              cwd: appRoot,
              detached: true,
              stdio: "ignore",
            }).unref();
          }, RESTART_DELAY_MS);
        }
        return Response.json({ ok: build.ok, kept: `.kyb-trash/schedules/${slug}.ts` });
      }),
    ] as never),
  });
}

export default manageChannel;

// ── Tools ───────────────────────────────────────────────────────────────────

/**
 * Let the AGENT manage its own routines, from any surface.
 *
 * Without these, "remind me every day at 10am" has no mechanism behind it — and
 * a model asked for a reminder will happily answer "got it" because that is what
 * the conversation calls for. It is not lying so much as having no way to tell
 * that it cannot. Give it the capability and the confirmation becomes true.
 *
 * The same file-writing path as the management routes, so a routine created by
 * asking and one created from KYBER Studio are the same source file.
 */
export function routineTools(options: ManageOptions = {}) {
  const appRoot = options.appRoot ?? process.cwd();
  const manageModule = options.channelModule ?? "kyb";

  /**
   * Apply a change WITHOUT holding the turn open.
   *
   * Rebuilding takes the better part of a minute, and awaiting it inside a tool
   * call means the user watches "Reading create_routine result" for that whole
   * time with nothing to show for it. The file is already written when this
   * runs, so the answer is knowable immediately — the build, and the restart
   * that makes it live, belong behind the conversation rather than inside it.
   */
  const applyInBackground = (): void => {
    const restart = options.restartCommand;
    const steps = restart
      ? `sleep 8 && npx eve build && sleep ${Math.round(RESTART_DELAY_MS / 1000)} && ${restart}`
      : "sleep 8 && npx eve build";
    // One at a time. A routine made and deleted a few seconds apart started two
    // builds over the same output, and the agent was never restarted, so the
    // change never went live. flock queues the second behind the first (each still
    // rebuilds from the files as they are when it starts); without flock
    // (macOS) the steps run as before.
    const lock = join(appRoot, ".eve", "kyb-apply.lock");
    const script = `mkdir -p ${JSON.stringify(dirname(lock))}; if command -v flock >/dev/null 2>&1; then flock -w 900 ${JSON.stringify(lock)} -c ${JSON.stringify(steps)}; else ${steps}; fi`;
    spawn(process.env.SHELL ?? "/bin/bash", ["-lc", script], {
      cwd: appRoot,
      detached: true,
      stdio: "ignore",
    }).unref();
  };

  return {
    create_routine: {
      description:
        "Create a recurring routine for yourself: something you will do on a schedule without being asked again. Use when the user asks to be reminded, to get a digest, or for anything repeating. Requires a cron expression — convert their words yourself (every day at 10am is `0 10 * * *`, weekday mornings at 8:40 is `40 8 * * 1-5`).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name, e.g. 'creatine reminder'" },
          cron: { type: "string", description: "5-field cron, in the user's timezone as the host runs it" },
          instruction: {
            type: "string",
            description: "What to do each time. Write it as an instruction to yourself, with enough context to act on alone.",
          },
        },
        required: ["name", "cron", "instruction"],
      },
      /**
       * `ctx` is the tool's context. Pass it: the routine then runs as the person
       * whose turn this is. Without it (an older tool file) it runs as the agent.
       */
      execute: async (input: { name: string; cron: string; instruction: string }, ctx?: unknown) => {
        const writable = writableRoot(appRoot);
        if (!writable.ok) throw new Error(writable.reason);

        const slug = slugify(input.name);
        const file = join(appRoot, "agent/schedules", `${slug}.ts`);
        if (existsSync(file)) {
          throw new Error(`A routine named "${slug}" already exists. Pick another name or delete it.`);
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          routineSource({
            name: slug,
            cron: input.cron,
            instruction: input.instruction,
            manageChannelModule: manageModule,
            owner: routineOwner((ctx as { session?: { auth?: { current?: unknown } } } | undefined)?.session?.auth?.current, slug),
          }),
          "utf8",
        );

        applyInBackground();
        // The card the person sees: the schedule in words, so they can catch a
        // wrong cron at a glance, and the next run. Clients read it from the
        // result; a tool passing `forModel` to `toModelOutput` keeps it out of
        // the model's context.
        //
        // A routine is live only after the rebuild and restart (two builds, about
        // two minutes), and a time that passes before then is never caught up. So
        // the next run is counted from when it goes live, and a first time that
        // comes sooner is said plainly rather than promised.
        const soonest = nextCronRun(input.cron);
        const nextRun = options.restartCommand ? nextCronRun(input.cron, new Date(Date.now() + LIVE_AFTER_MS)) : soonest;
        const missesFirst = Boolean(soonest && soonest !== nextRun);
        return withCards(
          {
            created: true,
            name: slug,
            cron: input.cron,
            file: `agent/schedules/${slug}.ts`,
            ...(nextRun ? { firstRun: nextRun } : {}),
            note: !options.restartCommand
              ? "Written. It needs a rebuild and restart to take effect."
              : missesFirst
                ? `Written, but it goes live in about two minutes, after its first time (${soonest}) has passed, so it will not run then.${nextRun ? ` Its first run is ${nextRun}.` : " It will not run at all."} Tell the user plainly, and that Run it now on the card runs it straight away in the background.`
                : "Written. It goes live in about two minutes, when I reload. Tell the user it is set and finish your reply now.",
          },
          card(
            "routine",
            {
              name: input.name.trim().slice(0, 120) || slug,
              schedule: describeCron(input.cron),
              ...(nextRun ? { nextRun } : {}),
              // The cron runs in host time; with it and the host's offset the apps say it in the reader's zone.
              cron: input.cron.trim(),
              offset: -new Date(nextRun ?? Date.now()).getTimezoneOffset(),
            },
            {
              id: `routine-${slug}`,
              source: "Routine",
              actions: [
                // Runs it in the background (POST /thread/run), so its answer is a
                // report, not a reply. The words are for clients that cannot, and
                // for an agent that does not serve that route (they fall back).
                {
                  label: "Run it now",
                  routine: slug,
                  say: `Run the "${slug}" routine now, as if it were its scheduled time.`,
                  primary: true,
                },
                { label: "Change it", say: `I'd like to change the "${slug}" routine. Ask me what to change.` },
              ],
            },
          ),
        );
      },
      /** For the tool's `toModelOutput`: the model reads the result and a note, not the card. */
      toModelOutput: (output: unknown) => forModel(output),
    },

    list_routines: {
      description:
        "List the routines you currently run on a schedule. Use before creating one to avoid duplicates, and when the user asks what you are doing for them automatically.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const dir = join(appRoot, "agent/schedules");
        if (!existsSync(dir)) return { routines: [] };
        const routines = readdirSync(dir)
          .filter((f) => f.endsWith(".ts"))
          .map((f) => {
            const source = readFileSync(join(dir, f), "utf8");
            return {
              name: f.replace(/\.ts$/, ""),
              cron: /cron:\s*"([^"]+)"/.exec(source)?.[1] ?? null,
              // Both shapes: `markdown:` is the pre-0.8.4 form that discarded
              // its output, still on disk until a routine is recreated.
              instruction:
                (/markdown:\s*"((?:[^"\\]|\\.)*)"/.exec(source)?.[1] ??
                  /\.send\(\s*"((?:[^"\\]|\\.)*)"/.exec(source)?.[1] ??
                  null)?.replace(/\\"/g, '"') ?? null,
            };
          });
        return { routines };
      },
    },

    delete_routine: {
      description:
        "Stop and remove one of your routines. Only when the user asks — a routine they set up and forgot is not a reason to remove it.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      execute: async (input: { name: string }) => {
        const dir = join(appRoot, "agent/schedules");
        const slug = slugify(input.name);
        const file = join(dir, `${slug}.ts`);
        if (!existsSync(file)) throw new Error(`No routine named "${slug}".`);
        // Moved OUT of agent/schedules/, not renamed inside it: eve rejects any
        // file there that is not .ts or .md, so a backup left in place stops the
        // agent from building at all. Undo should not cost the user their agent.
        const trash = join(appRoot, ".kyb-trash/schedules");
        mkdirSync(trash, { recursive: true });
        writeFileSync(join(trash, `${slug}.ts`), readFileSync(file, "utf8"), "utf8");
        await run(`rm -f ${JSON.stringify(file)}`, appRoot);
        applyInBackground();
        return { deleted: true, name: slug, kept: `.kyb-trash/schedules/${slug}.ts` };
      },
    },
  };
}

export { readRoutine, routineOwner, routineSource, type RoutineOwner, type RoutineRun, type RoutineSourceInput } from "./routine-source.js";
export { TicketStore, probeComputer, ticketFromUrl, type ComputerOptions } from "./computer.js";
export { fileRoutes, resolveDelivery, deliveryHeaders, deliveryDir, type FilesOptions } from "./files.js";
export {
  artifactRoutes,
  artifactsDir,
  listVisible,
  sharesDir,
  shareArtifact,
  SHARED_PAGE_POLICY,
  visibleTo,
  type ArtifactShare,
  type ArtifactsOptions,
  type ArtifactViewer,
} from "./artifacts.js";
export { screenRoutes, screensDir, type ScreensOptions } from "./screens.js";
export { memoryRoutes, memoryConfig, callMemory, contentOf, MEMORY_MCP_URL, type MemoryOptions } from "./memory.js";

/** The name `eve add` needs: bare catalog names belong to the Kybernesis registry. */
export function registryItemRef(item: string): string {
  const name = item.trim();
  return name.includes("/") ? name : `@kybernesis/${name}`;
}

export {
  SafeRestarter,
  setupRoutes,
  setupStatus,
  vncPassword,
  VNC_PASSWORD,
  type SetupItem,
  type SetupOptions,
  type SetupStatus,
  type RestartState,
} from "./setup.js";
export {
  SETUP_ENV_KEYS,
  applyEnvUpdate,
  classifyAuthoredReach,
  inFlightRuns,
  MODEL_REACH_ENV,
  resolveSwitchedReach,
  parseEnv,
  validateEnvUpdate,
  type AuthoredReach,
  type EnvUpdate,
  type ModelReachState,
} from "./setup-env.js";

export { listSessions, type SessionSummary, type SessionSurface, type ListSessionsOptions } from "./sessions.js";
export {
  threadAddress,
  runAddress,
  readThread,
  threadsDir,
  pendingContext,
  recapContext,
  exchangesFrom,
  writeThread,
  updateThread,
  noteSession,
  threadOwnerOf,
  newRunCapture,
  captureRunEvent,
  runCards,
  AGENT_OWNER,
  type ThreadRecord,
  type ThreadReport,
  type ThreadSession,
} from "./thread.js";
export { threadRoutes, personPrincipal } from "./thread-routes.js";
