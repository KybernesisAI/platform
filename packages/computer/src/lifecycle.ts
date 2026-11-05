import { installComputerUse, startComputerUse } from "eve/computer-use/sandbox";
import type { SandboxSession } from "eve/sandbox";
import { hasCurrentInstall, hasEarlierInstall, installChrome, installDesktopShell, markCurrentInstall, startDesktopShell } from "./provider.js";

/**
 * Everything the computer needs, once, at `eve build`: eve's desktop stack,
 * then Chrome, then the person's launcher bar — and then the desktop itself,
 * so the shared screen shows a real desktop from the moment the build ends,
 * not a black display waiting for the first session to open the sandbox.
 *
 * A computer started from a current bake (see `bakeComputerImage`), or one an
 * earlier build already installed for the same bake key, has all three, so it
 * only starts the desktop. Installing on every build made every restart depend
 * on outside package servers: on 2026-10-31 Mozilla stopped listing the Firefox
 * ESR line eve's installer requires, and an agent whose computer was already
 * complete could not rebuild and stayed down. For the same reason a failed
 * install on a computer that an earlier prepare finished is a warning, not a
 * failed build: the stack already there keeps working.
 *
 * eve's installer is run without its Firefox step (see `withoutFirefox`), so a
 * brand-new computer no longer depends on Mozilla listing one ESR line.
 */
export async function prepareComputer(sandbox: SandboxSession): Promise<void> {
  if (!(await hasCurrentInstall(sandbox))) {
    try {
      await installComputerUse(withoutFirefox(sandbox));
      await installChrome(sandbox);
      await installDesktopShell(sandbox);
      await markCurrentInstall(sandbox);
    } catch (error) {
      if (!(await hasEarlierInstall(sandbox))) throw error;
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.warn(`computer: install failed, keeping the stack an earlier build installed (${reason})`);
    }
  }
  await startComputer(sandbox);
}

/**
 * Per session: the display and driver (only if they are not already up), then
 * the launcher bar.
 *
 * eve's display start is not safe to repeat on a computer that outlives its
 * sessions. Every run opens a new D-Bus session and starts another
 * xfsettingsd on it; `--replace` only reaches the one on the same bus, so the
 * old ones stay connected to the X server. Each restart and eval left one
 * behind, and at about 240 Xvfb had no client slots left and the next build
 * could not open the display. So a computer that is already up is left alone,
 * and a start first clears the settings daemons it would otherwise pile on.
 */
export async function startComputer(sandbox: SandboxSession): Promise<void> {
  const up = await sandbox.run({ command: computerUpCommand(sandbox) });
  if (up.exitCode !== 0) {
    await sandbox.run({ command: "pkill -x xfsettingsd || true" });
    await startComputerUse(sandbox);
  }
  await startDesktopShell(sandbox);
}

/**
 * @internal Exits 0 when the display, the window manager and eve's driver are
 * all up (eve's own readiness test, plus a settings daemon). On the way it
 * stops every xfsettingsd but the newest, which clears a pile left by earlier
 * versions; only the newest owns the display's settings.
 */
export function computerUpCommand(sandbox: Pick<SandboxSession, "resolvePath">): string {
  const root = sandbox.resolvePath("computer-use");
  const driverRoot = sandbox.resolvePath(".eve-code/computer-use-driver");
  return [
    "set -u",
    "newest=$(pgrep -n -x xfsettingsd || true)",
    'for pid in $(pgrep -x xfsettingsd || true); do [ "$pid" = "$newest" ] || kill "$pid" 2>/dev/null || true; done',
    '[ -n "$newest" ] || exit 1',
    "xdpyinfo -display :99 >/dev/null 2>&1 || exit 1",
    "DISPLAY=:99 xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -Eq 'window id # 0x[1-9a-f]' || exit 1",
    `COMPUTER_USE_REQUEST='{"action":"health"}' COMPUTER_USE_SOCKET_PATH='${root}/cua-driver.sock' node '${driverRoot}/client.mjs' >/dev/null 2>&1 || exit 1`,
    "exit 0",
  ].join("\n");
}

/** The script eve's `installComputerUse` writes into the computer and then runs. */
const INSTALL_SCRIPT = /install-computer-use\.sh$/;

/**
 * eve's computer-use install script without its Firefox ESR steps: Mozilla's
 * apt repository, the check that it lists the 140 line, and the install.
 *
 * On 2026-10-31 Mozilla stopped listing Firefox ESR 140 (only 153 remains), so
 * eve's installer exits before anything else is installed and every brand-new
 * computer failed `eve build`. This computer never keeps Firefox: `installChrome`
 * removes it right after, and every page opens in Chrome. So nothing is lost by
 * not installing it, and the build stops depending on that repository at all.
 *
 * A script that does not have the expected shape (a later eve) is returned as
 * it is, so this can only ever remove the Firefox steps, never break the rest.
 *
 * @internal Exported for tests.
 */
export function stripFirefoxInstall(script: string): string {
  const repository = /install -d -m 0755 \/etc\/apt\/keyrings\n[\s\S]*?FIREFOX_ESR_VERSION="[^\n]*\nif \[\[ -z "\$\{FIREFOX_ESR_VERSION\}" \]\]; then\n[^\n]*\n[^\n]*\nfi\n/;
  const install = /DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\\n\s*"firefox-esr=\$\{FIREFOX_ESR_VERSION\}"\napt-get clean\n/;
  if (!repository.test(script) || !install.test(script)) return script;
  return script.replace(repository, "").replace(install, "");
}

/** @internal The sandbox as eve's installer sees it: the same, except the install script it writes has no Firefox steps. */
export function withoutFirefox(sandbox: SandboxSession): SandboxSession {
  return new Proxy(sandbox, {
    get(target, property) {
      if (property === "writeTextFile") {
        return (input: Parameters<SandboxSession["writeTextFile"]>[0]) =>
          target.writeTextFile(
            INSTALL_SCRIPT.test(input.path) && typeof input.content === "string"
              ? { ...input, content: stripFirefoxInstall(input.content) }
              : input,
          );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
