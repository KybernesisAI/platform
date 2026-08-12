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
        }, 250);

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
  prompt: ${JSON.stringify(body.instruction)},
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
          }, 250);
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
        const disabled = join(dir, `${slug}.ts.disabled`);
        writeFileSync(disabled, readFileSync(join(dir, match), "utf8"), "utf8");
        writeFileSync(join(dir, match), "");
        await run(`rm -f ${JSON.stringify(join(dir, match))}`, appRoot);

        const build = await run("npx eve build", appRoot);
        if (options.restartCommand && build.ok) {
          setTimeout(() => {
            spawn(process.env.SHELL ?? "/bin/bash", ["-lc", options.restartCommand!], {
              cwd: appRoot,
              detached: true,
              stdio: "ignore",
            }).unref();
          }, 250);
        }
        return Response.json({ ok: build.ok, kept: `agent/schedules/${slug}.ts.disabled` });
      }),
    ],
  });
}

export default manageChannel;
