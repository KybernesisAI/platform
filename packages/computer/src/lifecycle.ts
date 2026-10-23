import { installComputerUse, startComputerUse } from "eve/computer-use/sandbox";
import type { SandboxSession } from "eve/sandbox";
import { installChrome, installDesktopShell, isBakedComputer, startDesktopShell } from "./provider.js";

/**
 * Everything the computer needs, once, at `eve build`: eve's desktop stack,
 * then Chrome, then the person's launcher bar — and then the desktop itself,
 * so the shared screen shows a real desktop from the moment the build ends,
 * not a black display waiting for the first session to open the sandbox.
 *
 * A computer started from a current bake (see `bakeComputerImage`) already
 * has all three installed, so it only starts the desktop.
 */
export async function prepareComputer(sandbox: SandboxSession): Promise<void> {
  if (!(await isBakedComputer(sandbox))) {
    await installComputerUse(sandbox);
    await installChrome(sandbox);
    await installDesktopShell(sandbox);
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
