import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

// The workshop's warm-start claim, exercised for real: Playwright + Chromium
// baked into the ENVIRONMENT (once), inherited by every session.
export const environment = DockerSandbox.environment({
  prepare: async (sandbox) => {
    await sandbox.run({
      command: "mkdir -p /workspace/shot && cd /workspace/shot && npm init -y && npm install playwright",
    });
    await sandbox.run({
      command: "cd /workspace/shot && npx playwright install --with-deps chromium",
    });
  },
});

export default defineSandbox(() => environment.open());
