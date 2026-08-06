import { defaultBackend, defineSandbox } from "eve/sandbox";

/**
 * The Kybernesis engineer workshop: a warm, safe cloud dev machine.
 *
 * - TEMPLATE bootstrap (runs once, inherited by every session): pnpm +
 *   Playwright + Chromium. First use takes minutes; warm sessions run the
 *   full render→screenshot→vision loop in seconds.
 * - Deployed (Vercel Sandbox) sessions run under a domain ALLOWLIST — an
 *   agent that installs arbitrary npm packages must not have open egress.
 *   Local dev (Docker backend) runs allow-all (Docker only supports
 *   allow-all/deny-all).
 * - A blocked domain fails loudly; extend the allowlist deliberately for
 *   what the client's projects genuinely need. Treat every addition as a
 *   security decision.
 */
export default defineSandbox({
  backend: defaultBackend({
    vercel: {
      resources: { vcpus: 4 },
      networkPolicy: {
        allow: [
          // package installs
          "registry.npmjs.org",
          "*.npmjs.org",
          // git + repo tarballs (credentials are brokered at the firewall)
          "github.com",
          "api.github.com",
          "codeload.github.com",
          "*.githubusercontent.com",
          // playwright browser downloads (template bootstrap)
          "cdn.playwright.dev",
          "playwright.azureedge.net",
          "playwright.download.prss.microsoft.com",
          "storage.googleapis.com",
          // apt for browser system deps (template bootstrap) — the Vercel
          // Sandbox base image is Ubuntu; keep Debian mirrors for other bases
          "archive.ubuntu.com",
          "security.ubuntu.com",
          "ports.ubuntu.com",
          "*.ubuntu.com",
          "deb.debian.org",
          "security.debian.org",
          "*.debian.org",
          // model + deploy platform
          "ai-gateway.vercel.sh",
          "vercel.com",
          "*.vercel.app",
          // common webfont fetches during rendering
          "fonts.googleapis.com",
          "fonts.gstatic.com",
        ],
      },
    },
  }),
  revalidationKey: () => "kybernesis-workshop-v5",
  async bootstrap({ use }) {
    const sandbox = await use();
    // The sandbox egress proxy carries HTTPS only; apt defaults to http://
    // mirrors, so every index fetch silently fails. Rewrite to https first.
    await sandbox.run({
      command:
        "find /etc/apt -type f \\( -name '*.list' -o -name '*.sources' \\) -exec sed -i 's|http://|https://|g' {} + && apt-get update",
    });
    await sandbox.run({ command: "npm install -g pnpm" });
    // Explicit package.json: `npm init -y` derives the name from the directory
    // and npm rejects names starting with a dot (".shot").
    await sandbox.run({
      command:
        "mkdir -p /workspace/.shot && cd /workspace/.shot && echo '{\"name\":\"kyb-shot\",\"private\":true}' > package.json && npm install playwright",
    });
    await sandbox.run({
      command: "cd /workspace/.shot && npx playwright install --with-deps chromium",
    });
  },
});
