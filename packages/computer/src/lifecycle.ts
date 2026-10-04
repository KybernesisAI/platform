import { installComputerUse, startComputerUse } from "eve/computer-use/sandbox";
import type { SandboxSession } from "eve/sandbox";
import { installChrome, installDesktopShell, startDesktopShell } from "./provider.js";

/**
 * Everything the computer needs, once, at `eve build`: eve's desktop stack,
 * then Chrome, then the person's launcher bar — and then the desktop itself,
 * so the shared screen shows a real desktop from the moment the build ends,
 * not a black display waiting for the first session to open the sandbox.
 */
export async function prepareComputer(sandbox: SandboxSession): Promise<void> {
  await installComputerUse(sandbox);
  await installChrome(sandbox);
  await installDesktopShell(sandbox);
  await startComputer(sandbox);
}

/** Per session: the display and driver (if not already up), then the launcher bar. */
export async function startComputer(sandbox: SandboxSession): Promise<void> {
  await startComputerUse(sandbox);
  await startDesktopShell(sandbox);
}
