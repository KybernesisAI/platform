import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { verifyKybernesisRequest } from "@kybernesis/enterprise";
import { defineChannel, GET, POST } from "eve/channels";

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
async function authorize(req: Request, options: ManageOptions): Promise<Response | null> {
  const issuer = options.issuer ?? process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai";
  const agent = options.agent ?? process.env.KYBERNESIS_AGENT;
  if (!agent) {
    return Response.json(
      { ok: false, error: "This agent has no KYBERNESIS_AGENT set, so it cannot check grants." },
      { status: 500 },
    );
  }
  const result = await verifyKybernesisRequest(req, { issuer, agent });
  if (result.ok) return null;
  return Response.json({ ok: false, error: result.error }, { status: result.status });
}

export interface ManageOptions {
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

  return defineChannel({
    routes: [
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
      POST(PREFIX + "/install", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as { item?: string };
        if (!body.item) return Response.json({ ok: false, error: "item is required" }, { status: 400 });

        const writable = writableRoot(appRoot);
        if (!writable.ok) return Response.json({ ok: false, error: writable.reason }, { status: 409 });

        // `eve add` owns the whole recipe — files, deps, env keys — so a client
        // never has to reimplement it and drift from what the CLI does.
        const install = await run(`npx --yes eve add ${JSON.stringify(body.item)} --yes`, appRoot);
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
        const denied = await authorize(req, options);
        if (denied) return denied;
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
        const source = `import { defineSchedule } from "eve/schedules";

/** Created from KYBER Studio. */
export default defineSchedule({
  cron: ${JSON.stringify(body.cron)},
  markdown: ${JSON.stringify(body.instruction)},
});
`;
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
    ],
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
    const script = restart
      ? `sleep 8 && npx eve build && sleep ${Math.round(RESTART_DELAY_MS / 1000)} && ${restart}`
      : "sleep 8 && npx eve build";
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
      execute: async (input: { name: string; cron: string; instruction: string }) => {
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
          `import { defineSchedule } from "eve/schedules";\n\n/** ${input.name} */\nexport default defineSchedule({\n  cron: ${JSON.stringify(input.cron)},\n  markdown: ${JSON.stringify(input.instruction)},\n});\n`,
          "utf8",
        );

        applyInBackground();
        return {
          created: true,
          name: slug,
          cron: input.cron,
          file: `agent/schedules/${slug}.ts`,
          note: options.restartCommand
            ? "Written. It goes live in about a minute, when I reload — tell the user it is set and finish your reply now."
            : "Written. It needs a rebuild and restart to take effect.",
        };
      },
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
              instruction: /markdown:\s*"((?:[^"\\]|\\.)*)"/.exec(source)?.[1]?.replace(/\\"/g, '"') ?? null,
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
