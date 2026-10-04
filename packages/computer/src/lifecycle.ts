import { installComputerUse, startComputerUse } from "eve/computer-use/sandbox";
import type { SandboxSession } from "eve/sandbox";
import { installChrome, installDesktopShell, startDesktopShell } from "./provider.js";

/** Everything the computer needs, once, at `eve build`: eve's desktop stack, then Chrome, then the person's launcher bar. */
export async function prepareComputer(sandbox: SandboxSession): Promise<void> {
  await installComputerUse(sandbox);
  await installChrome(sandbox);
  await installDesktopShell(sandbox);
}

/** Per session: the display and driver (if not already up), then the launcher bar. */
export async function startComputer(sandbox: SandboxSession): Promise<void> {
  await startComputerUse(sandbox);
  await startDesktopShell(sandbox);
}
