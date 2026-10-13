import { manageChannel } from "@kybernesis/manage";

// Management routes for KYBER Studio and the web control plane: install a
// registry item, write a schedule, rebuild, restart. Authorized by the caller's
// control-plane identity and their grant on THIS agent — the same decision
// that lets them talk to it.
//
// Setup routes (/eve/v1/kyb/setup) let the agent's OWNER (a manage grant)
// finish setup with no terminal: model reach (the exe LLM gateway by default,
// an Anthropic or OpenAI key, or a Claude subscription sign-in), Slack
// credentials, an iMessage line, the Link wallet and the computer's screen
// password. Changes apply at a restart that waits until no conversation is in
// flight. Pass `setup: false` to leave them out.
//
// The agent edits its own repository, so this only works where the repo is
// present and writable (a VM, a container with the working copy). On a
// read-only serverless bundle the routes refuse with that reason rather than
// reporting a success that vanishes on the next deploy.
//
// restartCommand is what makes an install take effect. Without it the response
// says a restart is still required instead of claiming the change is live. On
// exe hosts it is the agent's systemd unit; `kyb init --host=exe` wires it.
export default manageChannel({
  // appRoot: "/home/exedev/my-agent",
  // restartCommand: "sudo -n systemctl restart my-agent-agent",
});
