/**
 * ## Read this before deploying: the credential this backend requires
 *
 * exe.dev separates programmatic VM lifecycle from interactive shell, and an
 * SSH key registered THROUGH an API token inherits that token's command scope.
 * Such a key cannot open a shell — the registration response attaches
 * `permissions.cmds` to the key itself, and exec is refused with
 * `Permission denied (publickey)`. Verified directly, twice.
 *
 * Running commands therefore requires a **full-permission account SSH key** on
 * the agent host, which grants shell to EVERY VM on that exe.dev account.
 *
 * That is acceptable under exactly one deployment shape, which this backend
 * enforces at prewarm: the exe.dev account is **dedicated to this agent** and
 * holds nothing but the agent's own VM and its sandboxes. Then "shell to every
 * VM on the account" means the agent's own compute — which it already has. If
 * the account holds anything else, the guard refuses to start and names the
 * foreign VMs. Override with `allowSharedAccount: true` only when the client
 * has explicitly accepted that blast radius in writing.
 *
 * If the client will not provision a separate exe.dev account, use eve's
 * `docker()` backend on the agent's own VM instead. It is the safer default and
 * what `kyb init --host=exe --engineer` scaffolds.
 *
 * Measured while proving this out:
 * - VM create ~4s; clone of a prepared template ~2s; prewarm+bootstrap ~7s.
 * - Clones DO carry disk state, but only after `sync` — writes sitting in the
 *   page cache are absent from the snapshot, silently.
 * - /workspace is root-owned on the base image; create it with sudo + chown.
 * - Template VMs outlive the process: adopt an existing one rather than
 *   recreating it, or creation fails on a name collision.
 * - Sandbox VM names get REUSED, so host keys change. Never use the caller's
 *   known_hosts: a stale entry silently reroutes SSH into exe.dev's REPL,
 *   where every command returns 'command not found' and looks like a dead VM.
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
 * Two credentials, deliberately separated so neither alone is enough:
 *
 * 1. `EXE_API_TOKEN` — a **scoped** exe.dev API token used only for VM
 *    lifecycle. It cannot open a shell. Mint it narrow and short-lived:
 *    ```bash
 *    ssh exe.dev "ssh-key generate-api-key --label=<agent>-sandbox \
 *      --cmds='ls,new,rm,cp' --exp=7d"
 *    ```
 * 2. `EXE_SANDBOX_SSH_KEY` — a full-permission account SSH key that executes
 *    commands inside sandbox VMs. It cannot be scoped (see the note above), so
 *    the account it belongs to must be dedicated to this agent.
 *
 * The token cannot run code and the key cannot create VMs, so a leak of either
 * one is recoverable: rotate the token via `ssh-key remove`, or remove the key
 * from the account.
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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
  /**
   * PEM contents of the account SSH key that executes sandbox commands.
   * Defaults to `EXE_SANDBOX_SSH_KEY`. Written to a 0600 temp file at use.
   */
  sshKey?: string;
  /**
   * Path to that key instead of its contents. Defaults to
   * `EXE_SANDBOX_SSH_KEY_PATH`. Takes precedence over `sshKey`.
   */
  sshKeyPath?: string;
  /**
   * The agent's own VM name, excluded from the dedicated-account check.
   * Defaults to `EXE_VM_NAME`, then the host's own hostname.
   */
  agentVmName?: string;
  /**
   * Skip the dedicated-account guard. The sandbox key grants shell to every VM
   * on the account, so only set this when the client has explicitly accepted
   * that blast radius. The guard exists because the alternative — discovering
   * the exposure after an incident — is not recoverable.
   */
  allowSharedAccount?: boolean;
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

/** Wrap a command line for `bash -lc`, quoting it as a single POSIX argument. */
function loginShell(commandLine: string): string {
  return `bash -lc '${commandLine.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a command over SSH against a sandbox VM, collecting stdout/stderr.
 *
 * `login: true` runs through `bash -lc` so toolchains that install onto the
 * profile PATH (nvm, pyenv, cargo, anything bootstrap adds to ~/.profile) are
 * found. A non-interactive SSH command does NOT source the profile, so without
 * this an agent gets `node: command not found` on a VM where node plainly
 * works interactively. It is off for internal file I/O, whose stdout must stay
 * byte-clean — a profile that prints anything would corrupt the payload.
 */
function sshRun(
  host: string,
  keyPath: string,
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
    login?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const envPrefix = options.env
    ? `${Object.entries(options.env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ")} `
    : "";
  const cd = `cd ${JSON.stringify(options.cwd ?? DEFAULT_WORKDIR)} && `;
  const inner = `${cd}${envPrefix}${command}`;
  const remote = options.login ? loginShell(inner) : inner;
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

  // The account SSH key that actually executes commands. Materialized to a
  // 0600 temp file once per process when supplied as contents.
  let keyDir: string | null = null;
  let keyPath: string | null = null;

  const ensureKey = async (): Promise<string> => {
    if (keyPath) return keyPath;

    const explicitPath = options.sshKeyPath ?? process.env.EXE_SANDBOX_SSH_KEY_PATH;
    if (explicitPath) {
      keyPath = explicitPath;
      return keyPath;
    }

    const contents = options.sshKey ?? process.env.EXE_SANDBOX_SSH_KEY;
    if (!contents) {
      throw new Error(
        "exeSandbox: no sandbox SSH key. Set EXE_SANDBOX_SSH_KEY (PEM contents) or " +
          "EXE_SANDBOX_SSH_KEY_PATH. It must be a FULL-PERMISSION account key: a key " +
          "registered through an API token inherits that token's command scope and cannot " +
          "open a shell. Register it from an already-authenticated session with " +
          "`ssh exe.dev \"ssh-key add '<public key>'\"`, on an account dedicated to this agent.",
      );
    }
    keyDir ??= mkdtempSync(join(tmpdir(), "exe-sbx-"));
    const priv = join(keyDir, "id_ed25519");
    // The trailing newline is mandatory; OpenSSH rejects a key file without one.
    writeFileSync(priv, contents.endsWith("\n") ? contents : `${contents}\n`, { mode: 0o600 });
    chmodSync(priv, 0o600);
    keyPath = priv;
    return keyPath;
  };

  /**
   * Refuse to run when the account holds VMs this agent does not own.
   *
   * The sandbox key grants shell to every VM on the account, so a shared
   * account silently hands the agent — and anything that compromises it —
   * shell on unrelated machines. Prewarm is the last point where that is still
   * cheap to fix, so fail loudly here rather than discovering it in an incident.
   */
  let accountChecked = false;
  const assertDedicatedAccount = async (log?: (m: string) => void): Promise<void> => {
    if (accountChecked || options.allowSharedAccount) return;
    const out = (await exeExec("ls --json", { apiToken: token(), apiBase })) as {
      vms?: { name?: string; vm_name?: string }[];
    };
    const own = (options.agentVmName ?? process.env.EXE_VM_NAME ?? hostname()).split(".")[0];
    const foreign = (out.vms ?? [])
      .map((v) => v.name ?? v.vm_name ?? "")
      .filter((n) => n && !n.startsWith(`${namePrefix}-`) && n.split(".")[0] !== own);
    if (foreign.length > 0) {
      throw new Error(
        `exeSandbox: refusing to start — the exe.dev account holds ${foreign.length} VM(s) ` +
          `this agent does not own: ${foreign.join(", ")}. The sandbox SSH key grants shell to ` +
          `EVERY VM on the account, so the account must be dedicated to this agent (its own VM ` +
          `"${own}" plus sandboxes prefixed "${namePrefix}-"). Move the agent to its own ` +
          `exe.dev account, or set allowSharedAccount: true if the client has accepted that ` +
          `blast radius.`,
      );
    }
    accountChecked = true;
    log?.(`exe: account check passed (own VM "${own}", sandbox prefix "${namePrefix}-")`);
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

  /**
   * Wait until SSH reaches the VM ITSELF, not exe.dev's lobby REPL.
   *
   * When a VM name's route is stale — most often right after a delete and
   * recreate of the same name — `<name>.exe.xyz` resolves to the exe.dev REPL
   * instead. The REPL accepts the connection and answers every command with
   * `command not found`, so a naive readiness probe either passes against the
   * wrong host or fails with an empty error while the VM shows `running`. Both
   * are miserable to debug, so require a sentinel echoed back by a real shell.
   */
  const READY_SENTINEL = "__exe_sbx_ready__";
  const waitForSsh = async (vm: ExeVm, key: string): Promise<void> => {
    const deadline = Date.now() + bootTimeout;
    let lastError = "";
    let sawRepl = false;
    while (Date.now() < deadline) {
      const probe = await sshRun(vm.host, key, `echo ${READY_SENTINEL}`, { cwd: "/" }).catch(
        (e: Error) => {
          lastError = e.message;
          return null;
        },
      );
      if (probe?.stdout.includes(READY_SENTINEL)) return;
      if (probe) {
        const combined = `${probe.stdout}${probe.stderr}`;
        if (/exe\.dev repl/i.test(combined)) {
          sawRepl = true;
          lastError = "SSH is landing on the exe.dev lobby REPL, not the VM (stale route).";
        } else {
          lastError = (probe.stderr || probe.stdout).slice(0, 200);
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(
      `exeSandbox: VM ${vm.name} did not accept SSH within ${bootTimeout}ms. ${lastError}` +
        (sawRepl
          ? ` This VM name's route is stale — exe.dev reuses names, and a name deleted and` +
            ` recreated within a few minutes can keep resolving to the lobby. Session VMs use a` +
            ` unique suffix to avoid this; a template VM hitting it needs a new templateKey or a` +
            ` few minutes for the route to settle.`
          : ""),
    );
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
        login: true,
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
            loginShell(`cd ${JSON.stringify(opts.cwd ? resolvePath(opts.cwd) : workdir)} && ${cmd}`),
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
      removePath: async (opts: { path: string; force?: boolean; recursive?: boolean }) => {
        const flags = `${opts.recursive ? "r" : ""}${opts.force ? "f" : ""}`;
        const r = await sshRun(vm.host, key, `rm ${flags ? `-${flags}` : ""} ${quote(opts.path)}`, {
          cwd: "/",
        });
        if (r.exitCode !== 0 && !opts.force) {
          throw new Error(`removePath ${opts.path}: ${r.stderr.trim()}`);
        }
      },
      /**
       * A sandbox VM has no host-level firewall this backend can drive, so the
       * only policies it can honor honestly are the two it can enforce with
       * local rules. Anything finer (per-domain allow-lists, header injection)
       * would be a silent no-op, and a network policy that silently does
       * nothing is worse than one that refuses.
       */
      setNetworkPolicy: async (policy: unknown) => {
        const mode = typeof policy === "string" ? policy : (policy as { mode?: string })?.mode;
        if (mode === "allow-all") return;
        if (mode === "deny-all") {
          const r = await sshRun(
            vm.host,
            key,
            "sudo -n iptables -P OUTPUT DROP && sudo -n iptables -A OUTPUT -o lo -j ACCEPT",
            { cwd: "/" },
          );
          if (r.exitCode !== 0) {
            throw new Error(`setNetworkPolicy deny-all failed: ${r.stderr.trim()}`);
          }
          return;
        }
        throw new Error(
          `exeSandbox: unsupported network policy ${JSON.stringify(mode)}. This backend ` +
            `honors only "allow-all" and "deny-all"; per-domain policies need a firewall ` +
            `it does not control, and pretending to apply one would be worse than refusing.`,
        );
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
      await assertDedicatedAccount(input.log);
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
        // Never reuse a session VM name. exe.dev recycles names, and a name
        // recreated soon after deletion can keep routing to the lobby REPL —
        // which looks exactly like a VM that boots but refuses every command.
        // A unique suffix sidesteps the whole class of problem; reconnect does
        // not depend on the name being derivable, since captureState stores it.
        const unique = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
        vm = await createVm(vmName(`${input.sessionKey.slice(0, 12)}-${unique}`), template?.name);
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
      // The sandbox key belongs to the operator's account — never deregister
      // it. Only the temp copy of it is ours to clean up.
      if (keyDir) rmSync(keyDir, { recursive: true, force: true });
      keyDir = null;
      keyPath = null;
    },
  };
}
