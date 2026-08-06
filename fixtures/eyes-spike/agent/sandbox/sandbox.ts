import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

// The workshop's warm-start claim, exercised for real: Playwright + Chromium
// baked into the TEMPLATE (once), inherited by every session.
export default defineSandbox({
  backend: docker(),
  revalidationKey: () => "eyes-spike-playwright-v1",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.run({
      command: "mkdir -p /workspace/shot && cd /workspace/shot && npm init -y && npm install playwright",
    });
    await sandbox.run({
      command: "cd /workspace/shot && npx playwright install --with-deps chromium",
    });
  },
});
