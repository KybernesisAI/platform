import { defineSandbox } from "eve/sandbox";
import { DockerComputer, prepareComputer, startComputer } from "@kybernesis/computer";

// The agent's own computer: ONE persistent container (home and /workspace are
// volumes, so Chrome's logins survive sessions) with its screen shared over
// VNC/noVNC on this host's loopback :6080 — reachable only through exe.dev's
// signed-in port proxy or an SSH tunnel. A person watching can take over.
export const environment = DockerComputer.environment({
  name: process.env.COMPUTER_NAME ?? "agent-computer",
  vncPassword: process.env.COMPUTER_VNC_PASSWORD,
  prepare: prepareComputer, // eve's desktop stack + Chrome + the launcher bar, once at `eve build`
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await startComputer(sandbox);
  return sandbox;
});
