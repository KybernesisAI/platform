import { defineTool } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import { BROWSER_OVERRIDES, type BrowserOverride, decideBrowserUse } from "./policy.js";
import { CHROME_DEBUG_PORT, openChromeCommand } from "./provider.js";

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

/**
 * Close every Chrome tab but one. The computer shares memory with the agent
 * host and stale tabs are the spender. Through Chrome's DevTools port rather
 * than keystrokes: a keystroke loop once closed the LAST tab too, Chrome quit,
 * and a session cookie set a minute earlier was gone. One tab always stays,
 * so Chrome and its session state outlive the clean-up.
 */
export function closeTabsTool() {
  return defineTool({
    description: "Close all Chrome tabs on your computer except the one you are using. Do this when you are done with a site.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const sandbox = await ctx.getSandbox();
      const result = await sandbox.run({
        command: [
          `set -e`,
          `list=$(curl -s --max-time 3 http://127.0.0.1:${CHROME_DEBUG_PORT}/json/list || true)`,
          `[ -n "$list" ] || { echo "Chrome is not open"; exit 0; }`,
          // Pages only (not workers/extensions), oldest first; keep the newest.
          `ids=$(printf '%s' "$list" | python3 -c 'import json,sys; pages=[t for t in json.load(sys.stdin) if t.get("type")=="page"]; print("\n".join(t["id"] for t in pages[1:]))')`,
          `n=0; for id in $ids; do curl -s --max-time 3 "http://127.0.0.1:${CHROME_DEBUG_PORT}/json/close/$id" >/dev/null && n=$((n+1)); done`,
          `echo "closed $n tab(s); 1 left open"`,
        ].join("\n"),
      });
      return { ok: result.exitCode === 0, detail: (result.stdout || result.stderr).trim() };
    },
  });
}
