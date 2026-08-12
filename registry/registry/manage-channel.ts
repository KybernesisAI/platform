import { manageChannel } from "@kybernesis/manage";

// Management routes for KYBER Studio: install a registry item, write a
// schedule, rebuild, restart. Authorized by the caller's control-plane identity
// and their grant on THIS agent — the same decision that lets them talk to it.
//
// The agent edits its own repository, so this only works where the repo is
// present and writable (a VM, a container with the working copy). On a
// read-only serverless bundle the routes refuse with that reason rather than
// reporting a success that vanishes on the next deploy.
//
// restartCommand is what makes an install take effect. Without it the response
// says a restart is still required instead of claiming the change is live.
export default manageChannel({
  // appRoot: "/home/exedev/my-agent",
  // restartCommand: "bash ~/restart.sh",
});
