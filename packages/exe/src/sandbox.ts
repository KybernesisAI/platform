/**
 * NOT USABLE AS WRITTEN — kept as a documented dead end and a measurement log.
 *
 * exe.dev deliberately separates programmatic VM lifecycle from interactive
 * shell. An SSH key registered THROUGH an API token inherits that token's
 * command scope, and arbitrary shell exec is not a scoped command, so such a
 * key is refused with 'command not allowed by SSH key permissions'. Adding
 * 'ssh' to the token scope only permits the REPL's own ssh command, and the
 * HTTPS API refuses exec outright ('ssh command requires an SSH session').
 *
 * The only working path is a FULL-PERMISSION account SSH key on the agent host
 * — a long-lived credential granting shell to every VM on the account. That is
 * the opposite of what this backend was for, and not something to hand a
 * client. Use eve's docker() backend on the agent's own VM instead.
 *
 * Measured while proving this out (all still true and useful):
 * - VM create ~4s; clone of a prepared template ~2s; prewarm+bootstrap ~7s.
 * - Clones DO carry disk state, but only after `sync` — writes sitting in the
 *   page cache are absent from the snapshot, silently.
 * - /workspace is root-owned on the base image; create it with sudo + chown.
 * - Template VMs outlive the process: adopt an existing one rather than
 *   recreating it, or creation fails on a name collision.
 * - Sandbox VM names get REUSED, so host keys change. Never use the caller's
 *   known_hosts: a stale entry silently reroutes SSH into exe.dev's REPL,
 *   where every command returns 'command not found' and looks like a dead VM.
 *
 * Revisit only if exe.dev adds a scoped exec path (a token running commands on
 * a VM it owns) — that is the missing primitive.
 */
/**
 * exe.dev VM-backed sandbox for eve agents — OPTIONAL.
 * Import from `@kybernesis/exe/sandbox` only when an agent runs code.
 *
 * ## Why a VM instead of a container
 *
 * eve's built-in backends give an agent a container (`docker()`) or a hosted
 * Vercel Sandbox (`vercel()`). This backend gives it a whole exe.dev VM:
 *
 * - **Real isolation**, with Docker available *inside* each sandbox.
 * - **A public HTTPS URL per sandbox** (`https://<vm>.exe.xyz`), so an agent
 *   that builds a web app can hand over a working preview link directly —
 *   no separate deploy step and no Vercel dependency.
 * - **~4 second create, ~4 second clone** of a prepared template (measured),
 *   which is faster than rebuilding a container template.
 *
 * ## How it authenticates
 *
 * Two credentials, deliberately separated:
 *
 * 1. `EXE_API_TOKEN` — a **scoped** exe.dev API token used only for VM
 *    lifecycle. Mint it narrow and short-lived:
 *    ```bash
 *    ssh exe.dev "ssh-key generate-api-key --label=<agent>-sandbox \
 *      --cmds='new,rm,ls,cp,ssh-key add,ssh-key remove' --exp=7d"
 *    ```
 * 2. An **ephemeral SSH keypair** this backend generates at prewarm, registers
 *    with the account, and removes on shutdown. It is what actually executes
 *    commands inside sandbox VMs. Nothing long-lived is placed on a sandbox.
 *
 * The agent host therefore never holds account-wide credentials, and a leaked
 * sandbox key expires with the token's scope rather than granting shell
 * anywhere forever.
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Options for {@link exeSandbox}. */
export interface ExeSandboxOptions {
  /**
   * Scoped exe.dev API token. Defaults to `EXE_API_TOKEN`. Needs only
   * `new,rm,ls,cp,ssh-key add,ssh-key remove`.
   */
  apiToken?: string;
  /** exe.dev API base. Defaults to `https://exe.dev`. */
  apiBase?: string;
  /**
   * Prefix for sandbox VM names. exe requires 5–52 chars, lowercase, starting
   * with a letter — keep this short so generated names stay in range.
   */
  namePrefix?: string;
  /** Seconds to wait for a new VM to accept SSH. Default 90. */
  bootTimeoutSeconds?: number;
  /** Working directory inside the sandbox. Default `/workspace`. */
  workdir?: string;
}

interface ExeVm {
  name: string;
  host: string;
  httpsUrl: string;
}

const DEFAULT_WORKDIR = "/workspace";

/** POST a CLI command to the exe.dev HTTPS API. The body is the command line. */
async function exeExec(
  command: string,
  opts: { apiToken: string; apiBase: string },
): Promise<unknown> {
  const res = await fetch(`${opts.apiBase.replace(/\/$/, "")}/exec`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiToken}`,
      "content-type": "text/plain",
    },
    body: command,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `exe.dev API "${command.split(" ")[0]}" failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Run a command over SSH against a sandbox VM, collecting stdout/stderr. */
function sshRun(
  host: string,
  keyPath: string,
  command: string,
  options: { cwd?: string; env?: Record<string, string>; abortSignal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const envPrefix = options.env
    ? `${Object.entries(options.env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ")} `
    : "";
  const cd = `cd ${JSON.stringify(options.cwd ?? DEFAULT_WORKDIR)} && `;
  const remote = `${cd}${envPrefix}${command}`;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      "ssh",
      [
        "-i",
        keyPath,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=20",
        host,
        remote,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const onAbort = () => child.kill("SIGKILL");
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      options.abortSignal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/**
 * Create the exe.dev VM sandbox backend.
 *
 * ```ts title="agent/sandbox/sandbox.ts"
 * import { defineSandbox } from "eve/sandbox";
 * import { exeSandbox } from "@kybernesis/exe/sandbox";
 *
 * export default defineSandbox({
 *   backend: exeSandbox({ namePrefix: "sid-sbx" }),
 *   async bootstrap({ use }) {
 *     const sb = await use();
 *     await sb.run({ command: "sudo apt-get update && sudo apt-get install -y ..." });
 *   },
 * });
 * ```
 *
 * Lifecycle: `prewarm` builds ONE template VM (running `bootstrap` inside it)
 * and leaves it as the clone source; `create` clones that template per session
 * (~4s); `shutdown` deletes the session VM. Because template state is a real
 * VM image, anything bootstrap installs — Playwright, toolchains, a cloned
 * repo — is present instantly in every later session.
 */
export function exeSandbox(options: ExeSandboxOptions = {}) {
  const apiBase = options.apiBase ?? "https://exe.dev";
  const namePrefix = options.namePrefix ?? "sbx";
  const workdir = options.workdir ?? DEFAULT_WORKDIR;
  const bootTimeout = (options.bootTimeoutSeconds ?? 90) * 1000;

  const token = (): string => {
    const t = options.apiToken ?? process.env.EXE_API_TOKEN;
    if (!t) {
      throw new Error(
        "exeSandbox: no API token. Set EXE_API_TOKEN to a scoped exe.dev token " +
          "(ssh exe.dev \"ssh-key generate-api-key --label=<agent>-sandbox " +
          "--cmds='new,rm,ls,cp,ssh-key add,ssh-key remove' --exp=7d\").",
      );
    }
    return t;
  };

  // One ephemeral keypair per process, registered on first use.
  let keyDir: string | null = null;
  let keyPath: string | null = null;
  let keyRegistered = false;

  const ensureKey = async (): Promise<string> => {
    if (keyPath && keyRegistered) return keyPath;
    keyDir ??= mkdtempSync(join(tmpdir(), "exe-sbx-"));
    const priv = join(keyDir, "id_ed25519");
    if (!keyPath) {
      await new Promise<void>((resolve, reject) => {
        const kg = spawnProcess("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", priv], {
          stdio: "ignore",
        });
        kg.on("error", reject);
        kg.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ssh-keygen failed"))));
      });
      chmodSync(priv, 0o600);
      keyPath = priv;
    }
    const pub = readFileSync(`${priv}.pub`, "utf8").trim();
    await exeExec(`ssh-key add ${JSON.stringify(pub)}`, { apiToken: token(), apiBase });
    keyRegistered = true;
    return priv;
  };

  const vmName = (suffix: string): string =>
    `${namePrefix}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 52);

  const vmFromName = (name: string): ExeVm => ({
    name,
    host: `${name}.exe.xyz`,
    httpsUrl: `https://${name}.exe.xyz`,
  });

  /** Does a VM with this name already exist on the account? */
  const vmExists = async (name: string): Promise<boolean> => {
    const out = (await exeExec("ls", { apiToken: token(), apiBase })) as {
      vms?: { name?: string; vm_name?: string }[];
    };
    return (out.vms ?? []).some((v) => (v.name ?? v.vm_name) === name);
  };

  const createVm = async (name: string, from?: string): Promise<ExeVm> => {
    const cmd = from ? `cp ${from} ${name} --json` : `new --name ${name} --json`;
    const out = (await exeExec(cmd, { apiToken: token(), apiBase })) as Record<string, string>;
    return {
      name,
      host: out.ssh_host ?? out.ssh ?? `${name}.exe.xyz`,
      httpsUrl: out.https_url ?? `https://${name}.exe.xyz`,
    };
  };

  const waitForSsh = async (vm: ExeVm, key: string): Promise<void> => {
    const deadline = Date.now() + bootTimeout;
    let lastError = "";
    while (Date.now() < deadline) {
      const probe = await sshRun(vm.host, key, "true", { cwd: "/" }).catch((e: Error) => {
        lastError = e.message;
        return null;
      });
      if (probe && probe.exitCode === 0) return;
      if (probe) lastError = probe.stderr.slice(0, 200);
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`exeSandbox: VM ${vm.name} did not accept SSH within ${bootTimeout}ms. ${lastError}`);
  };

  /** Build the SandboxSession surface eve expects, over SSH to one VM. */
  const buildSession = (vm: ExeVm, key: string, id: string) => {
    const resolvePath = (p: string): string => (p.startsWith("/") ? p : `${workdir}/${p}`);
    const quote = (p: string) => JSON.stringify(resolvePath(p));

    const run = async (opts: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      abortSignal?: AbortSignal;
    }) => {
      const cmd = opts.args?.length
        ? `${opts.command} ${opts.args.map((a) => JSON.stringify(a)).join(" ")}`
        : opts.command;
      const r = await sshRun(vm.host, key, cmd, {
        cwd: opts.cwd ? resolvePath(opts.cwd) : workdir,
        env: opts.env,
        abortSignal: opts.abortSignal,
      });
      return { ...r, command: cmd };
    };

    const readTextFile = async (opts: { path: string }) => {
      const r = await sshRun(vm.host, key, `cat ${quote(opts.path)}`, { cwd: "/" });
      if (r.exitCode !== 0) throw new Error(`readTextFile ${opts.path}: ${r.stderr.trim()}`);
      return r.stdout;
    };

    const readBinaryFile = async (opts: { path: string }) => {
      const r = await sshRun(vm.host, key, `base64 -w0 ${quote(opts.path)}`, { cwd: "/" });
      if (r.exitCode !== 0) throw new Error(`readBinaryFile ${opts.path}: ${r.stderr.trim()}`);
      return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
    };

    const writeTextFile = async (opts: { path: string; content: string }) => {
      const b64 = Buffer.from(opts.content, "utf8").toString("base64");
      const p = quote(opts.path);
      const r = await sshRun(
        vm.host,
        key,
        `mkdir -p "$(dirname ${p})" && printf %s ${JSON.stringify(b64)} | base64 -d > ${p}`,
        { cwd: "/" },
      );
      if (r.exitCode !== 0) throw new Error(`writeTextFile ${opts.path}: ${r.stderr.trim()}`);
    };

    const writeBinaryFile = async (opts: { path: string; content: Uint8Array }) => {
      const b64 = Buffer.from(opts.content).toString("base64");
      const p = quote(opts.path);
      const r = await sshRun(
        vm.host,
        key,
        `mkdir -p "$(dirname ${p})" && printf %s ${JSON.stringify(b64)} | base64 -d > ${p}`,
        { cwd: "/" },
      );
      if (r.exitCode !== 0) throw new Error(`writeBinaryFile ${opts.path}: ${r.stderr.trim()}`);
    };

    return {
      id,
      resolvePath,
      run,
      readTextFile,
      readBinaryFile,
      writeTextFile,
      writeBinaryFile,
      // Stream variants map onto the byte helpers above.
      readFile: async (opts: { path: string }) => readBinaryFile(opts),
      writeFile: async (opts: { path: string; content: Uint8Array }) => writeBinaryFile(opts),
      /**
       * Long-running process. SSH keeps the channel open, so the returned
       * handle streams until the command exits or is killed.
       */
      spawn: async (opts: { command: string; args?: string[]; cwd?: string }) => {
        const cmd = opts.args?.length
          ? `${opts.command} ${opts.args.map((a) => JSON.stringify(a)).join(" ")}`
          : opts.command;
        const child = spawnProcess(
          "ssh",
          [
            "-i",
            key,
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "IdentitiesOnly=yes",
            vm.host,
            `cd ${JSON.stringify(opts.cwd ? resolvePath(opts.cwd) : workdir)} && ${cmd}`,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        return {
          pid: child.pid ?? 0,
          stdout: child.stdout,
          stderr: child.stderr,
          kill: () => child.kill("SIGKILL"),
          exited: new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 0))),
        };
      },
      /** exe-specific: the sandbox's own public URL, for shareable previews. */
      publicUrl: vm.httpsUrl,
      vmName: vm.name,
    };
  };

  const templates = new Map<string, ExeVm>();

  return {
    name: "exe",

    async prewarm(input: {
      templateKey: string;
      bootstrap?: (ctx: { use: () => Promise<unknown> }) => void | Promise<void>;
      log?: (m: string) => void;
      seedFiles: ReadonlyArray<{ path: string; content: string | Buffer }>;
    }): Promise<{ reused: boolean }> {
      if (templates.has(input.templateKey)) return { reused: true };
      const key = await ensureKey();
      const name = vmName(`tpl-${input.templateKey.slice(0, 12)}`);
      // Template VMs outlive the process. If one is already on the account for
      // this templateKey, adopt it instead of rebuilding — that is the whole
      // point of a template, and it makes prewarm idempotent across restarts.
      if (await vmExists(name)) {
        const existing = vmFromName(name);
        templates.set(input.templateKey, existing);
        input.log?.(`exe: reusing existing template VM ${name}`);
        return { reused: true };
      }
      input.log?.(`exe: creating template VM ${name}`);
      const vm = await createVm(name);
      await waitForSsh(vm, key);
      const session = buildSession(vm, key, input.templateKey);
      // /workspace is root-owned on the base image; create it once and hand it
      // to the login user so every later file op works without sudo.
      await session.run({
        command: `sudo -n mkdir -p ${JSON.stringify(workdir)} && sudo -n chown -R $(id -u):$(id -g) ${JSON.stringify(workdir)}`,
        cwd: "/",
      });
      for (const file of input.seedFiles) {
        await session.writeBinaryFile({
          path: file.path,
          content:
            typeof file.content === "string"
              ? new Uint8Array(Buffer.from(file.content, "utf8"))
              : new Uint8Array(file.content),
        });
      }
      if (input.bootstrap) {
        input.log?.("exe: running bootstrap in the template VM");
        await input.bootstrap({ use: async () => session });
      }
      // Flush before the template can be cloned: exe clones from a disk
      // snapshot, and writes still sitting in the page cache do NOT appear in
      // the clone. Without this, a session VM comes up missing everything
      // bootstrap just installed — silently, since the clone itself succeeds.
      await session.run({ command: "sync", cwd: "/" });
      templates.set(input.templateKey, vm);
      input.log?.(`exe: template ${name} ready (clones take ~4s)`);
      return { reused: false };
    },

    async create(input: {
      templateKey: string | null;
      sessionKey: string;
      existingMetadata?: Record<string, unknown>;
    }) {
      const key = await ensureKey();
      const existing = input.existingMetadata?.vmName as string | undefined;
      let vm: ExeVm;
      if (existing) {
        vm = { name: existing, host: `${existing}.exe.xyz`, httpsUrl: `https://${existing}.exe.xyz` };
      } else {
        const template = input.templateKey ? templates.get(input.templateKey) : undefined;
        vm = await createVm(vmName(input.sessionKey.slice(0, 20)), template?.name);
        await waitForSsh(vm, key);
      }
      const session = buildSession(vm, key, input.sessionKey);
      return {
        session: session as never,
        useSessionFn: (async () => session) as never,
        captureState: async () => ({
          backendName: "exe",
          metadata: { vmName: vm.name, httpsUrl: vm.httpsUrl },
          sessionKey: input.sessionKey,
        }),
        shutdown: async () => {
          await exeExec(`rm ${vm.name}`, { apiToken: token(), apiBase }).catch(() => undefined);
        },
      };
    },

    /** Remove the ephemeral key and template VMs. Call on server shutdown. */
    async dispose(): Promise<void> {
      for (const vm of templates.values()) {
        await exeExec(`rm ${vm.name}`, { apiToken: token(), apiBase }).catch(() => undefined);
      }
      templates.clear();
      if (keyPath && keyRegistered) {
        const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
        await exeExec(`ssh-key remove ${JSON.stringify(pub)}`, {
          apiToken: token(),
          apiBase,
        }).catch(() => undefined);
        keyRegistered = false;
      }
      if (keyDir) rmSync(keyDir, { recursive: true, force: true });
    },
  };
}
