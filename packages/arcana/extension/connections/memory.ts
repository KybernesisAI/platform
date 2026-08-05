import { defineMcpClientConnection } from "eve/connections";

import extension from "../extension";

// Static-key auth by design: Vercel Connect's interactive OAuth is broken for
// deployed agents, and subagent sessions carry no user principal to bind a
// grant to. The `X-Kyberagent-Agent` header is required by Arcana in addition
// to the Bearer token — it selects the workspace.
export default defineMcpClientConnection({
  url: "https://mcp.arcana.kybernesis.ai/mcp",
  description:
    "Durable long-term memory (Kybernesis Arcana): remember facts, decisions, people, and preferences; recall and search what is already known; review the timeline; read and write brain notes.",
  auth: {
    getToken: async () => ({ token: extension.config.apiKey }),
  },
  headers: {
    "X-Kyberagent-Agent": async (ctx) =>
      (await extension.config.resolveWorkspace?.(ctx)) ??
      extension.config.workspace,
  },
});
