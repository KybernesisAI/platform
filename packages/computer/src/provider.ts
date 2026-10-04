/**
 * A persistent, isolated computer for an agent — one Docker container that
 * outlives every session, with a desktop a person can watch and take over.
 *
 * eve's built-in sandboxes are disposable by design: a fresh container per
 * session, state kept only while that session lives. That is right for code
 * tasks and wrong for the thing people actually want from an agent with a
 * browser: sign in to a site ONCE, and have the agent still be signed in next
 * week. Grok Bot's answer is a persistent cloud computer per account; this is
 * the same idea, as an eve sandbox provider:
 *
 * - ONE container per agent (`name`), started on first use and kept running
 *   (`--restart unless-stopped`); every eve session opens the same computer.
 * - `/workspace` and the agent user's home are Docker volumes, so files,
 *   Firefox profile, cookies and logins persist across sessions, restarts,
 *   and image rebuilds.
 * - The display (`:99`) is shared over VNC from INSIDE the container; noVNC is
 *   published on the host's loopback only (`127.0.0.1:6080` by default), so
 *   the only ways in are an SSH tunnel or exe.dev's signed-in port proxy. A
 *   person watching can take the mouse and keyboard — that is the
 *   "take over" flow for passwords, codes and CAPTCHAs, and nothing they type
 *   there passes through the model.
 * - It is still a container: the agent cannot reach the host's files,
 *   credentials or the other agents on the machine. Sessions share the
 *   computer, so this is one computer per AGENT, never per account.
 *
 * `prepare` runs at `eve build` inside the live computer (eve's
 * `installComputerUse` is the intended payload); `open()` returns the running
 * computer; the session hooks never delete it.
 */
import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import type { SandboxSession } from "eve/sandbox";
import {
  defineSandboxProvider,
  type SandboxProviderHandle,
  type SandboxProviderResources,
  type SandboxProviderTargetFile,
} from "eve/sandbox/provider";

export interface DockerComputerEnvironmentOptions {
  /** Container name; one computer per agent. Default `agent-computer`. */
  name?: string;
  /** Base image. Must be apt-based with `sudo`; the default is built from `COMPUTER_DOCKERFILE`. */
  image?: string;
  /** Host port (loopback) for noVNC. Default 6080; `0` publishes nothing. */
  novncPort?: number;
  /** Docker memory limit for the computer (Chrome is the spender). Default `3g`; `""` for none. */
  memoryLimit?: string;
  /** VNC password handed to x11vnc inside the computer (a second gate behind the port proxy). */
  vncPassword?: string;
  /** Screen size for the shared display. */
  screen?: { width: number; height: number };
  /** Extra environment for every command. */
  env?: Readonly<Record<string, string>>;
  /** Runs once at `eve build`, inside the computer — e.g. eve's `installComputerUse`. */
  prepare?: (sandbox: SandboxSession) => Promise<void> | void;
}

export interface DockerComputerOpenOptions {
  env?: Readonly<Record<string, string>>;
}

interface DockerComputerArtifact {
  readonly container: string;
  readonly image: string;
  readonly version: 1;
  readonly [key: string]: string | number;
}

interface DockerComputerSessionState {
  readonly container: string;
  readonly version: 1;
}

const WORKSPACE = "/workspace";
const USER = "agent";
const HOME = `/home/${USER}`;
const DISPLAY = ":99";

/**
 * The computer's base image: Ubuntu with sudo, Node (for eve's computer-use
 * driver), x11vnc + noVNC for the shared screen, and a supervisor that keeps
 * the display and the viewer up. eve's `installComputerUse` adds xfce,
 * Firefox ESR and the driver on top at `eve build`.
 */
export const COMPUTER_DOCKERFILE = `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
      sudo ca-certificates curl gnupg bash coreutils procps \\
      xvfb x11-utils x11vnc novnc websockify python3 \\
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash -u 1001 ${USER} \\
    && echo '${USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${USER} \\
    && mkdir -p ${WORKSPACE} && chown ${USER}:${USER} ${WORKSPACE}
COPY <<'EOS' /usr/local/bin/computer-view
#!/bin/bash
# The computer's screen, from the moment the container starts: display :99
# (the same one eve's computer-use uses — its start script checks for an
# existing display first) shared over VNC + noVNC. Without this the screen
# only existed once an agent session had opened the sandbox, and a person
# opening noVNC before that saw "Failed to connect to server".
export DISPLAY=:99
mkdir -p "$HOME/.vnc"
if [ -n "\${VNC_PASSWORD:-}" ]; then x11vnc -storepasswd "\$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1; AUTH="-rfbauth $HOME/.vnc/passwd"; else AUTH="-nopw"; fi
websockify --web /usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/websockify.log 2>&1 &
while true; do
  if ! xdpyinfo -display :99 >/dev/null 2>&1 && command -v Xvfb >/dev/null; then
    setsid -f Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR >/tmp/xvfb.log 2>&1
  fi
  until xdpyinfo -display :99 >/dev/null 2>&1; do sleep 2; done
  x11vnc -display :99 \$AUTH -forever -shared -rfbport 5900 -noxdamage -quiet >/tmp/x11vnc.log 2>&1
  sleep 2
done
EOS
RUN chmod 0755 /usr/local/bin/computer-view
USER ${USER}
WORKDIR ${WORKSPACE}
ENV HOME=${HOME} DISPLAY=${DISPLAY}
CMD ["/usr/local/bin/computer-view"]
`;

/** Marker on the container's own filesystem (not a volume): a recreated container has no marker and prepares itself. */
const PREPARED_MARKER_DIR = "/usr/local/share/kybernesis-computer";
const PREPARED_MARKER = `${PREPARED_MARKER_DIR}/prepared`;

/**
 * A container recreated from the image (recipe change, `docker rm`) has lost
 * everything `prepare` installed into its filesystem layer. eve only re-runs
 * `prepare` when it decides the template changed, so the session would run
 * on a computer with no Chrome and no driver. Check the marker and prepare here.
 */
async function ensurePrepared(session: SandboxSession, prepare: DockerComputerEnvironmentOptions["prepare"]): Promise<void> {
  if (!prepare) return;
  const marker = await session.run({ command: `test -f ${PREPARED_MARKER}` });
  if (marker.exitCode === 0) return;
  await prepare(session);
  await session.run({ command: `sudo -n mkdir -p ${PREPARED_MARKER_DIR} && sudo -n touch ${PREPARED_MARKER}` });
}

function recipeHash(): string {
  return createHash("sha256").update(COMPUTER_DOCKERFILE).digest("hex").slice(0, 10);
}

function docker(args: string[], options: { input?: string | Uint8Array; env?: Record<string, string> } = {}) {
  return new Promise<{ exitCode: number; stdout: Buffer; stderr: string }>((resolveRun, reject) => {
    const child = nodeSpawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(options.env ?? {}) } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function dockerOk(args: string[], what: string, input?: string | Uint8Array): Promise<Buffer> {
  const result = await docker(args, { input });
  if (result.exitCode !== 0) throw new Error(`${what} failed (docker exit ${result.exitCode}): ${result.stderr.trim()}`);
  return result.stdout;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createSession(input: { container: string; env: Readonly<Record<string, string>> }): SandboxSession {
  const { container, env } = input;
  const resolvePath = (path: string): string => {
    if (!path || path === ".") return WORKSPACE;
    if (path.startsWith("$HOME")) return HOME + path.slice(5);
    if (path.startsWith("~")) return HOME + path.slice(1);
    return path.startsWith("/") ? path : `${WORKSPACE}/${path}`.replace(/\/\.\//g, "/");
  };
  const execArgs = (options: { command: string; workingDirectory?: string; env?: Record<string, string> }, interactive = false): string[] => {
    const args = ["exec", ...(interactive ? ["-i"] : []), "-u", USER, "-w", options.workingDirectory ? resolvePath(options.workingDirectory) : WORKSPACE];
    for (const [k, v] of Object.entries({ HOME, DISPLAY, ...env, ...(options.env ?? {}) })) args.push("-e", `${k}=${v}`);
    // A plain shell, never a login shell: a login shell runs ~/.bash_logout on exit, whose
    // clear_console fails without a TTY and turns every successful command into exit 1.
    return [...args, container, "bash", "-c", options.command];
  };

  return {
    resolvePath,
    async run(options) {
      const result = await docker(execArgs(options));
      return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
    },
    async spawn(options) {
      const child = nodeSpawn("docker", execArgs(options), { stdio: ["ignore", "pipe", "pipe"], signal: options.abortSignal });
      const exitCode = new Promise<number>((resolveExit) => {
        child.on("close", (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
        child.on("error", () => resolveExit(1));
      });
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: async () => ({ exitCode: await exitCode }),
        kill: async () => {
          child.kill("SIGTERM");
        },
      };
    },
    async readFile({ path }) {
      const bytes = await this.readBinaryFile({ path });
      return bytes === null ? null : (Readable.toWeb(Readable.from([Buffer.from(bytes)])) as ReadableStream<Uint8Array>);
    },
    async readBinaryFile({ path }) {
      const result = await docker(["exec", "-u", USER, container, "cat", resolvePath(path)]);
      return result.exitCode === 0 ? new Uint8Array(result.stdout) : null;
    },
    async readTextFile({ path, encoding, startLine, endLine }) {
      const bytes = await this.readBinaryFile({ path });
      if (bytes === null) return null;
      const text = Buffer.from(bytes).toString((encoding ?? "utf8") as BufferEncoding);
      if (startLine === undefined && endLine === undefined) return text;
      const lines = text.split("\n");
      return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
    },
    async writeFile({ path, content }) {
      const bytes = new Uint8Array(await new Response(content).arrayBuffer());
      await this.writeBinaryFile({ path, content: bytes });
    },
    async writeBinaryFile({ path, content }) {
      const target = resolvePath(path);
      await dockerOk(
        ["exec", "-i", "-u", USER, container, "bash", "-c", `mkdir -p "$(dirname ${shellQuote(target)})" && cat > ${shellQuote(target)}`],
        `write ${target}`,
        content,
      );
    },
    async writeTextFile({ path, content, encoding }) {
      await this.writeBinaryFile({ path, content: new Uint8Array(Buffer.from(content, (encoding ?? "utf8") as BufferEncoding)) });
    },
    async removePath({ path, recursive, force }) {
      await dockerOk(["exec", "-u", USER, container, "rm", `-${recursive ? "r" : ""}${force ? "f" : ""}`.replace(/^-$/, "-d"), resolvePath(path)], `remove ${path}`);
    },
  };
}

function handleFor(session: SandboxSession): SandboxProviderHandle<SandboxSession> {
  return {
    sandbox: session,
    // The computer outlives every session on purpose; nothing is torn down.
    async onSessionStop() {},
    async onRuntimeShutdown() {},
    async onSessionDelete() {},
  };
}

async function containerState(name: string): Promise<"running" | "stopped" | "missing"> {
  const result = await docker(["inspect", "-f", "{{.State.Running}}", name]);
  if (result.exitCode !== 0) return "missing";
  return result.stdout.toString().trim() === "true" ? "running" : "stopped";
}

/** Bring the one computer up: build the base image if needed, create or start the container. */
async function ensureComputer(options: Required<Pick<DockerComputerEnvironmentOptions, "name" | "novncPort">> & DockerComputerEnvironmentOptions, log?: (m: string) => void): Promise<string> {
  // The tag carries a hash of the recipe, so a changed Dockerfile builds a new
  // image and the container is recreated from it; the home and /workspace
  // volumes carry everything that matters across that.
  const image = options.image ?? `kybernesis/agent-computer:${options.name}-${recipeHash()}`;
  if (!options.image) {
    const have = await docker(["image", "inspect", image]);
    if (have.exitCode !== 0) {
      log?.(`building the computer's base image ${image}`);
      await dockerOk(["build", "-t", image, "-f", "-", "."], "image build", COMPUTER_DOCKERFILE);
    }
  }
  let state = await containerState(options.name);
  if (state !== "missing") {
    const current = await docker(["inspect", "-f", "{{.Config.Image}}", options.name]);
    if (current.exitCode === 0 && current.stdout.toString().trim() !== image) {
      log?.(`recreating the computer from ${image} (its recipe changed; home and /workspace are kept)`);
      await dockerOk(["rm", "-f", options.name], "container remove");
      state = "missing";
    }
  }
  if (state === "missing") {
    log?.(`creating the computer ${options.name}`);
    const memory = options.memoryLimit ?? "3g";
    const args = ["run", "-d", "--name", options.name, "--restart", "unless-stopped", "--shm-size=1g",
      ...(memory ? ["--memory", memory] : []),
      "-v", `${options.name}-home:${HOME}`, "-v", `${options.name}-workspace:${WORKSPACE}`,
      "-e", `VNC_PASSWORD=${options.vncPassword ?? ""}`];
    if (options.novncPort > 0) args.push("-p", `127.0.0.1:${options.novncPort}:6080`);
    args.push(image);
    await dockerOk(args, "container create");
    // Volumes are created root-owned; hand them to the agent user once.
    await dockerOk(["exec", "-u", "root", options.name, "chown", `${USER}:${USER}`, HOME, WORKSPACE], "volume ownership");
  } else if (state === "stopped") {
    log?.(`starting the computer ${options.name}`);
    await dockerOk(["start", options.name], "container start");
  }
  return image;
}

export const DockerComputer = defineSandboxProvider<
  DockerComputerEnvironmentOptions | undefined,
  DockerComputerOpenOptions | undefined,
  DockerComputerArtifact,
  DockerComputerSessionState,
  SandboxSession
>({
  name: "docker-computer",
  environment(options) {
    const name = options?.name ?? "agent-computer";
    const novncPort = options?.novncPort ?? 6080;
    const env = options?.env ?? {};
    return {
      async prepare(context) {
        const image = await ensureComputer({ ...options, name, novncPort }, context.log);
        const session = createSession({ container: name, env });
        for (const file of targetFiles(context.resources)) {
          await session.writeTextFile({ path: file.path, content: typeof file.content === "string" ? file.content : Buffer.from(file.content).toString("utf8") });
        }
        if (options?.prepare) {
          context.log?.("preparing the computer");
          await options.prepare(session);
        }
        await session.run({ command: `sudo -n mkdir -p ${PREPARED_MARKER_DIR} && sudo -n touch ${PREPARED_MARKER}` });
        return { container: name, image, version: 1 };
      },
      async start(_context, open, artifact) {
        await ensureComputer({ ...options, name: artifact.container, novncPort }, undefined);
        const session = createSession({ container: artifact.container, env: { ...env, ...(open?.env ?? {}) } });
        await ensurePrepared(session, options?.prepare);
        return { handle: handleFor(session), state: { container: artifact.container, version: 1 } };
      },
      async resume(_context, artifact, state) {
        await ensureComputer({ ...options, name: state.container ?? artifact.container, novncPort }, undefined);
        const session = createSession({ container: state.container, env });
        await ensurePrepared(session, options?.prepare);
        return handleFor(session);
      },
    };
  },
});

function targetFiles(resources: SandboxProviderResources): SandboxProviderTargetFile[] {
  return [resources.workspace, resources.skills].flatMap((tree) =>
    tree === undefined ? [] : tree.files.map((file) => ({ content: file.content, path: `${tree.targetPath}/${file.relativePath}` })),
  );
}

// ---------------------------------------------------------------------------
// Chrome on the computer. eve's computer-use stack installs Firefox ESR and its
// `launch` action knows only Firefox and xterm; the browser people actually
// live in is Chrome, with its own profile, passkeys and extensions. So the
// computer installs Google Chrome, REMOVES Firefox (so nothing can fall back
// to it), and the agent opens pages with the `open_browser` tool below, which
// keeps one Chrome window on the shared display with a profile that persists
// under /workspace.
// ---------------------------------------------------------------------------

export const CHROME_PROFILE = `${WORKSPACE}/computer-use/chrome-profile`;

/** Run after `installComputerUse` in the environment's `prepare`. */
export async function installChrome(sandbox: SandboxSession): Promise<void> {
  const script = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "if ! command -v google-chrome-stable >/dev/null; then",
    "  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb",
    "  apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-liberation xdg-utils",
    "  rm -f /tmp/chrome.deb",
    "fi",
    // Firefox goes: a browser the person never wants must not be the one a
    // tool reaches for by habit.
    "apt-get remove -y firefox-esr >/dev/null 2>&1 || true",
    "apt-get clean && rm -rf /var/lib/apt/lists/*",
    // Everything that opens a URL from the desktop opens it in Chrome.
    `cat > ${WORKSPACE}/.eve-code/managed-browser/xdg-open <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
url="\${1:-}"
[[ "\${url}" =~ ^https?:// ]] || { echo "managed xdg-open accepts HTTP(S) URLs only" >&2; exit 2; }
exec ${WORKSPACE}/.eve-code/managed-browser/open-chrome "\${url}"
EOS`,
    `cat > ${WORKSPACE}/.eve-code/managed-browser/open-chrome <<'EOS'
#!/usr/bin/env bash
# Open a URL in the ONE Chrome window on the shared display. A running Chrome
# gets a new tab (Chrome's remote dispatch), a cold start creates the window.
set -euo pipefail
url="\${1:-about:blank}"
export DISPLAY=:99
mkdir -p ${CHROME_PROFILE}
setsid -f google-chrome-stable --no-sandbox --test-type --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check \\
  --user-data-dir=${CHROME_PROFILE} --window-position=0,0 --start-maximized "\${url}" </dev/null >> ${WORKSPACE}/computer-use/chrome.log 2>&1
for _ in $(seq 1 100); do
  window=$(xdotool search --onlyvisible --class google-chrome 2>/dev/null | tail -n 1 || true)
  [[ -n "\${window}" ]] && break
  sleep 0.1
done
[[ -n "\${window:-}" ]] || { echo "Chrome did not open a window" >&2; exit 1; }
xdotool windowactivate --sync "\${window}" >/dev/null 2>&1 || true
# Fill the screen (minus the panel): a half-width window wastes the shared display.
xdotool windowmove "\${window}" 0 0 windowsize "\${window}" 100% 96% >/dev/null 2>&1 || true
echo "opened \${url}"
EOS`,
    `chmod 0755 ${WORKSPACE}/.eve-code/managed-browser/xdg-open ${WORKSPACE}/.eve-code/managed-browser/open-chrome`,
    `chown -R ${USER}:${USER} ${WORKSPACE}/.eve-code/managed-browser`,
  ].join("\n");
  const path = `${WORKSPACE}/.eve-code/install-chrome.sh`;
  await sandbox.writeTextFile({ path, content: script });
  const result = await sandbox.run({ command: `sudo -n bash ${path}` });
  if (result.exitCode !== 0) throw new Error(`Chrome installation failed (exit ${result.exitCode}): ${result.stderr.slice(-800)}`);
}

/** The shell command that opens a URL in the computer's Chrome (for tools and hooks). */
export function openChromeCommand(url: string): string {
  return `${WORKSPACE}/.eve-code/managed-browser/open-chrome ${shellQuote(url)}`;
}

// ---------------------------------------------------------------------------
// A desktop shell for the PERSON. eve's display command starts a window manager
// on a black root — right for a model that only takes screenshots, useless for
// someone watching over VNC who wants to open a browser or a terminal. The
// computer adds the XFCE panel (Applications menu + launchers for Chrome,
// Terminal and Files) and the desktop, seeded so the panel's first-run dialog
// never appears. The launchers open Chrome with the SAME persistent profile the
// agent uses, so a login made by hand is a login the agent has.
// ---------------------------------------------------------------------------

const PANEL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=8;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="36"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/><value type="int" value="2"/><value type="int" value="3"/><value type="int" value="4"/><value type="int" value="5"/><value type="int" value="6"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu"/>
    <property name="plugin-2" type="string" value="launcher">
      <property name="items" type="array"><value type="string" value="chrome.desktop"/></property>
    </property>
    <property name="plugin-3" type="string" value="launcher">
      <property name="items" type="array"><value type="string" value="terminal.desktop"/></property>
    </property>
    <property name="plugin-4" type="string" value="launcher">
      <property name="items" type="array"><value type="string" value="files.desktop"/></property>
    </property>
    <property name="plugin-5" type="string" value="tasklist"/>
    <property name="plugin-6" type="string" value="clock"/>
  </property>
</channel>
`;

function desktopEntry(name: string, exec: string, icon: string, comment: string): string {
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${name}\nComment=${comment}\nExec=${exec}\nIcon=${icon}\nTerminal=false\nCategories=Utility;\n`;
}

/** Seed the panel layout and the launcher entries. Run in `prepare` (after `installChrome`). */
export async function installDesktopShell(sandbox: SandboxSession): Promise<void> {
  const openChrome = `${WORKSPACE}/.eve-code/managed-browser/open-chrome`;
  const files: Record<string, string> = {
    [`${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml`]: PANEL_XML,
    [`${HOME}/.config/xfce4/panel/launcher-2/chrome.desktop`]: desktopEntry("Chrome", `${openChrome} %U`, "google-chrome", "Chrome, with the computer's persistent profile"),
    [`${HOME}/.config/xfce4/panel/launcher-3/terminal.desktop`]: desktopEntry("Terminal", "xterm -fa 'GeistMono Nerd Font' -fs 14 -bg '#0A0A0A' -fg '#bbbbbb'", "utilities-terminal", "A shell on the computer"),
    [`${HOME}/.config/xfce4/panel/launcher-4/files.desktop`]: desktopEntry("Files", "thunar /workspace", "system-file-manager", "The computer's files"),
    // The Applications menu and xdg-open must reach the SAME Chrome profile:
    // override the stock Chrome entries for this user.
    [`${HOME}/.local/share/applications/google-chrome.desktop`]: desktopEntry("Google Chrome", `${openChrome} %U`, "google-chrome", "Chrome, with the computer's persistent profile") + "MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n",
    [`${HOME}/.local/share/applications/com.google.Chrome.desktop`]: "[Desktop Entry]\nType=Application\nName=Google Chrome (stock)\nNoDisplay=true\nHidden=true\n",
  };
  for (const [path, content] of Object.entries(files)) await sandbox.writeTextFile({ path, content });
  await sandbox.run({ command: `xdg-settings set default-web-browser google-chrome.desktop >/dev/null 2>&1 || true` });
}

/** Start the panel and the desktop on display :99 if they are not running. Call after `startComputerUse`. */
export async function startDesktopShell(sandbox: SandboxSession): Promise<void> {
  const command = [
    "set -u",
    `export DISPLAY=${DISPLAY}`,
    `[ -f ${WORKSPACE}/computer-use/dbus-session-address ] && export DBUS_SESSION_BUS_ADDRESS="$(cat ${WORKSPACE}/computer-use/dbus-session-address)"`,
    `pgrep -x xfce4-panel >/dev/null || setsid -f xfce4-panel --disable-wm-check </dev/null > ${WORKSPACE}/computer-use/panel.log 2>&1`,
    `pgrep -x xfdesktop >/dev/null || setsid -f xfdesktop --disable-wm-check </dev/null > ${WORKSPACE}/computer-use/xfdesktop.log 2>&1`,
    "exit 0",
  ].join("\n");
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) throw new Error(`desktop shell did not start: ${(result.stderr || result.stdout).slice(-400)}`);
}
