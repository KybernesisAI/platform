import { defineTool } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import { BROWSER_OVERRIDES, type BrowserOverride, decideBrowserUse } from "./policy.js";
import { CHROME_PROFILE, openChromeCommand } from "./provider.js";

export interface OpenBrowserOptions {
  /** Hosts covered by a connector, by service slug. Defaults to the Kybernesis catalogue. */
  connectorHosts?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Open a URL in Chrome on the agent's computer — with the guard: a site that
 * has a connector parks for the person's approval unless the model states a
 * legitimate override, so the wrong path becomes a question, never a silent
 * browse of something a connector should have handled.
 */
export function openBrowserTool(options: OpenBrowserOptions = {}) {
  return defineTool({
    description:
      "Open a URL in Chrome on your own computer's screen (the person may be watching). " +
      "Use it only for sites with NO connector, or with a stated override. Then use the computer tool to work in the page.",
    inputSchema: z.object({
      url: z.string().url().describe("The http(s) URL to open."),
      override: z
        .enum(BROWSER_OVERRIDES as [BrowserOverride, ...BrowserOverride[]])
        .optional()
        .describe(
          "Only when the site has a connector: why the browser is right anyway — the person asked for it, the action must be done as them, or they must see the page.",
        ),
    }),
    approval: ({ toolInput }: ApprovalContext) => {
      const input = toolInput as { url?: string; override?: BrowserOverride } | undefined;
      if (!input?.url) return "not-applicable";
      const decision = decideBrowserUse({ url: input.url, override: input.override, hosts: options.connectorHosts });
      return decision.kind === "ask" ? "user-approval" : "not-applicable";
    },
    async execute({ url, override }, ctx) {
      const decision = decideBrowserUse({ url, override, hosts: options.connectorHosts });
      const sandbox = await ctx.getSandbox();
      const result = await sandbox.run({ command: openChromeCommand(url) });
      if (result.exitCode !== 0) throw new Error(`Chrome did not open ${url}: ${(result.stderr || result.stdout).trim()}`);
      return {
        ok: true,
        url,
        note:
          "Chrome is open on the screen. Take a screenshot with the computer tool to see it." +
          (decision.kind === "ask" ? ` (The person approved opening ${decision.service} in the browser.)` : ""),
      };
    },
  });
}

/** Close every Chrome tab but the active one — the computer shares memory with the agent host. */
export function closeTabsTool() {
  return defineTool({
    description: "Close all Chrome tabs on your computer except the one you are using. Do this when you are done with a site.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const sandbox = await ctx.getSandbox();
      const result = await sandbox.run({
        command: [
          "export DISPLAY=:99",
          `window=$(xdotool search --onlyvisible --class google-chrome | tail -n 1)`,
          `[ -n "$window" ] || { echo "Chrome is not open"; exit 0; }`,
          `xdotool windowactivate --sync "$window"`,
          // Chrome: close other tabs via the keyboard — Ctrl+1 to the first tab,
          // then Ctrl+W on every tab after it from the end.
          `n=$(ls -1 ${CHROME_PROFILE}/Default/Sessions 2>/dev/null | wc -l)`,
          `for _ in $(seq 1 30); do xdotool key --clearmodifiers ctrl+9; sleep 0.05; xdotool key --clearmodifiers ctrl+w; sleep 0.1; done`,
          `echo closed`,
        ].join("\n"),
      });
      return { ok: result.exitCode === 0, detail: (result.stdout || result.stderr).trim() };
    },
  });
}
