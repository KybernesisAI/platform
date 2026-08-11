/** File templates written by `kyb init`. Kept in sync with the proven Kyber patterns. */

export const DEPT_DESCRIPTIONS: Record<string, string> = {
  finance:
    "Finance specialist: financials, budgets, spend, revenue, invoices, runway, and financial reporting. Keeps the finance team's own memory workspace. Delegate any finance-shaped task, question, or reporting request here.",
  marketing:
    "Marketing specialist: campaigns, content, positioning, brand, launches, social, and ads. Keeps the marketing team's own memory workspace. Delegate any marketing-shaped task or question here.",
  engineering:
    "Engineering specialist: production errors and incidents, architecture decisions, technical questions, and engineering documentation. Keeps the engineering team's own memory workspace. Delegate any engineering-shaped task or question here.",
};

export function deptDescription(dept: string): string {
  return (
    DEPT_DESCRIPTIONS[dept] ??
    `${dept[0].toUpperCase()}${dept.slice(1)} specialist. Keeps the ${dept} team's own memory workspace. Delegate ${dept}-shaped tasks and questions here. TODO: sharpen this routing description for the client.`
  );
}

export function identityMd(displayName: string, depts: string[]): string {
  const delegation = depts.length
    ? `
# Delegation

You have department specialists available as tools: ${depts.map((d) => `\`${d}\``).join(", ")}.
Each has its own memory workspace and tool surface. When a request is clearly
departmental, delegate to the specialist instead of answering from the shared
brain.

Brief them fully: a specialist sees none of this conversation, so pack
everything it needs into the message (who is asking, the specifics, any
constraints, and the desired output shape). Synthesize the specialist's answer
for the person — don't paste it raw. General company knowledge stays with you
and the shared brain.
`
    : "";
  return `# Identity

You are ${displayName}. You live in the company's chat surfaces: people
@mention you in channels and message you directly in DMs. Be concise and
concrete — chat is not a document editor. Prefer short paragraphs and bullet
lists.
${delegation}`;
}

export function subagentAgentTs(dept: string): string {
  return `import { defineAgent } from "eve";

export default defineAgent({
  description:
    ${JSON.stringify(deptDescription(dept))},
  model: "anthropic/claude-sonnet-5",
});
`;
}

export function subagentInstructionsMd(dept: string): string {
  return `# Identity

You are the ${dept} specialist. You receive fully-briefed tasks from the root
agent — you never see the original conversation, so treat the incoming message
as the complete brief and return a complete, self-contained answer.

# Memory

You have the ${dept} team's own long-term memory workspace (Arcana) via the
\`arcana\` connection: recall, search, timeline, remember, and brain notes.

- Look up relevant context BEFORE answering. Never claim something isn't known
  without searching first (empty entity recall alone is not enough — escalate
  to search).
- Store new ${dept} facts and decisions proactively with \`arcana_remember\`
  (called via its qualified name); use brain notes (\`arcana_brain_write\` AND
  \`arcana_brain_add\`, always both) for long-form material.
- Load the \`recall\`, \`remember\`, or \`brain-note\` skill for the full
  procedure.
`;
}

export function subagentArcanaTs(dept: string): string {
  const upper = dept.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `import { defineMcpClientConnection } from "eve/connections";

const workspace = process.env.ARCANA_${upper}_WORKSPACE ?? "REPLACE-${dept}";

export default defineMcpClientConnection({
  url: "https://mcp.arcana.kybernesis.ai/mcp",
  description:
    "The ${dept} team's long-term memory (Arcana): remember, recall, search, timeline, and brain notes.",
  auth: {
    getToken: async () => {
      const token =
        (workspace.endsWith("-eval")
          ? process.env.ARCANA_EVAL_API_KEY
          : undefined) ??
        process.env.ARCANA_${upper}_API_KEY ??
        process.env.ARCANA_API_KEY;
      if (!token) throw new Error("ARCANA_${upper}_API_KEY is not set.");
      return { token };
    },
  },
  headers: { "X-Kyberagent-Agent": async () => workspace },
});
`;
}

export function rootArcanaTs(): string {
  return `import arcana from "@kybernesis/arcana";

// One brain for shared surfaces, optionally a second for DMs. Hermetic eval
// runs override ARCANA_COMPANY_WORKSPACE to "<client>-eval", which switches
// to the eval workspace's own key automatically.
const COMPANY = process.env.ARCANA_COMPANY_WORKSPACE ?? "REPLACE-company";
const DM = process.env.ARCANA_DM_WORKSPACE ?? COMPANY;

export default arcana({
  apiKey:
    (COMPANY.endsWith("-eval") ? process.env.ARCANA_EVAL_API_KEY : undefined) ??
    process.env.ARCANA_API_KEY!,
  workspace: COMPANY,
  // DM sessions carry surface:"dm" via @kybernesis/multiplayer.
  resolveWorkspace: (ctx) =>
    ctx.session.auth.current?.attributes.surface === "dm" ? DM : undefined,
});
`;
}

export function evalFileTs(displayName: string, depts: string[]): string {
  const routing = depts.map((d) => `    { subagent: ${JSON.stringify(d)} },`).join("\n");
  return `import { kybernesisBaseline } from "@kybernesis/evals";

export default kybernesisBaseline({
  agentDisplayName: ${JSON.stringify(displayName)},
${depts.length ? `  routing: [\n${routing}\n  ],\n` : ""}});
`;
}

export function envExample(name: string, depts: string[], issuer: string, channelEnv: string[] = []): string {
  const deptVars = depts
    .map((d) => {
      const upper = d.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      return `# ARCANA_${upper}_API_KEY="kb_..."\n# ARCANA_${upper}_WORKSPACE="${name}-${d}"`;
    })
    .join("\n");
  return `# ── Kybernesis agent environment ─────────────────────────────────────
# Real values belong in Vercel envs (prod/preview Sensitive); \`eve deploy\`
# overwrites .env.local from the development environment on every deploy.

# Control-plane governance (@kybernesis/enterprise)
KYBERNESIS_ISSUER="${issuer}"
KYBERNESIS_AGENT="${name}"

${channelEnv.length ? `# Channel\n${channelEnv.join("\n")}\n\n` : ""}# Arcana memory (@kybernesis/arcana) — one workspace + scoped kb_ key per brain
# ARCANA_API_KEY="kb_..."
# ARCANA_COMPANY_WORKSPACE="${name}-company"
# ARCANA_DM_WORKSPACE="${name}-company"
# ARCANA_EVAL_API_KEY="kb_..."   # key for the ${name}-eval workspace (hermetic evals)
${deptVars}
`;
}

export function evalScript(name: string, depts: string[]): string {
  const overrides = [
    `ARCANA_COMPANY_WORKSPACE=${name}-eval`,
    `ARCANA_DM_WORKSPACE=${name}-eval`,
    ...depts.map(
      (d) => `ARCANA_${d.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_WORKSPACE=${name}-eval`,
    ),
  ];
  return `${overrides.join(" ")} eve eval`;
}

// ── Channels ────────────────────────────────────────────────────────────
// Nothing is implied: a scaffold gets the channel(s) you ask for and no more.
// Each entry knows its file, the packages it needs, and the env it introduces.

export type ChannelKind = "none" | "slack" | "imessage" | "telegram" | "discord" | "web";

export const CHANNEL_KINDS: ChannelKind[] = [
  "none",
  "slack",
  "imessage",
  "telegram",
  "discord",
  "web",
];

export interface ChannelPlan {
  /** File written under agent/channels/, or null for `none`. */
  file: string | null;
  content: string;
  /** npm deps this channel needs beyond eve. */
  deps: string[];
  /** Registry items to `eve add` (interactive setup flows live there). */
  registryItems: string[];
  /** Env lines appended to .env.example. */
  env: string[];
  /** Human setup steps printed after scaffolding. */
  steps: string[];
}

export function channelPlan(kind: ChannelKind, name: string, host: HostKind): ChannelPlan {
  const onExe = host === "exe";
  switch (kind) {
    case "slack":
      return {
        file: "slack.ts",
        content: onExe
          ? `import { multiplayerSlackChannel } from "@kybernesis/multiplayer/slack";
import { forwardedSocketVerifier } from "@kybernesis/exe/slack";

// Slack on a self-hosted (exe.dev) host.
// Inbound: a forwarder holds the exe-brokered Socket Mode connection and POSTs
// events here; the verifier authenticates them on SLACK_SOCKET_FORWARDING_SECRET.
// Outbound: SLACK_BOT_TOKEN must be on the host — eve's SlackChannelCredentials
// has no apiUrl, so calls can't route through the exe integration yet.
export default multiplayerSlackChannel({
  credentials: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    webhookVerifier: forwardedSocketVerifier(),
  },
});
`
          : `import { connectSlackCredentials } from "@vercel/connect/eve";
import { multiplayerSlackChannel } from "@kybernesis/multiplayer/slack";

// Shared threads with per-speaker verified identity, attributed context, and
// dual surface (channel vs DM). Credentials are brokered by Vercel Connect.
export default multiplayerSlackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR_UID!),
});
`,
        deps: ["@kybernesis/multiplayer", ...(onExe ? ["@kybernesis/exe"] : ["@vercel/connect"])],
        registryItems: [],
        env: onExe
          ? [
              `SLACK_BOT_TOKEN="xoxb-..."   # outbound; from Slack OAuth & Permissions`,
              `SLACK_SOCKET_FORWARDING_SECRET="$(openssl rand -hex 24)"`,
            ]
          : [`SLACK_CONNECTOR_UID="slack/${name}"`],
        steps: onExe
          ? [
              `Create a Slack app (Socket Mode on; scopes: app_mentions:read, chat:write, channels:history, groups:history, im:history, users:read)`,
              `Hold its tokens off-host: ssh exe.dev integrations add slack --name ${name} --bot-token=- --app-token=-`,
              `Run the forwarder (scripts/slack-forwarder.py in @kybernesis/exe) with EXE_SLACK_GW set`,
              `After ANY scope change, reinstall the app — a stale token silently stops receiving events`,
            ]
          : [
              `vercel connect create slack --triggers --name ${name}`,
              `vercel connect detach <uid> --yes && vercel connect attach <uid> --triggers --trigger-path /eve/v1/slack --yes`,
            ],
      };
    case "imessage":
      return {
        file: "photon.ts",
        content: `import { photonIMessageChannel } from "eve/channels/photon";
${onExe ? `import { photonEnvCredentials } from "@kybernesis/exe/photon";\n` : ""}
// iMessage via Photon. Inbound is a plain webhook at /eve/v1/photon; the Photon
// signing secret takes precedence over the default Vercel-OIDC verifier, so this
// works on any host with a public HTTPS URL.
export default photonIMessageChannel({
${
  onExe
    ? `  credentials: photonEnvCredentials(),`
    : `  async credentials() {
    const projectId = process.env.IMESSAGE_PROJECT_ID;
    const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;
    if (!projectId || !projectSecret) throw new Error("Photon project credentials are required.");
    return { projectId, projectSecret };
  },`
}
  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
});
`,
        deps: onExe ? ["@kybernesis/exe"] : [],
        registryItems: [],
        env: [
          `IMESSAGE_PROJECT_ID="..."`,
          `IMESSAGE_PROJECT_SECRET="..."`,
          `IMESSAGE_WEBHOOK_SECRET="..."   # Photon webhook signing secret`,
        ],
        steps: [
          `Create a Photon project and register the phone number (npx eve add channel/photon-imessage walks it)`,
          onExe
            ? `Make the host public FIRST — webhooks need anonymous access:\n       ssh exe.dev share port <vm> 8000 && ssh exe.dev share set-public <vm>`
            : `Deploy so the public URL exists`,
          `Register a Photon webhook for https://<your-host>/eve/v1/photon and copy its signing secret to IMESSAGE_WEBHOOK_SECRET`,
        ],
      };
    case "telegram":
      return {
        file: "telegram.ts",
        content: `import { telegramChannel } from "eve/channels/telegram";

// Telegram. Register the webhook against your public URL after deploying.
export default telegramChannel({ botToken: process.env.TELEGRAM_BOT_TOKEN! });
`,
        deps: [],
        registryItems: [],
        env: [`TELEGRAM_BOT_TOKEN="..."   # from @BotFather`],
        steps: [
          `Create a bot with @BotFather and copy its token`,
          `After deploy: curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://<host>/eve/v1/telegram"`,
        ],
      };
    case "discord":
      return {
        file: "discord.ts",
        content: `import { discordChannel } from "eve/channels/discord";

export default discordChannel({ botToken: process.env.DISCORD_BOT_TOKEN! });
`,
        deps: [],
        registryItems: [],
        env: [`DISCORD_BOT_TOKEN="..."`],
        steps: [`Create a Discord application + bot, invite it, set DISCORD_BOT_TOKEN`],
      };
    case "web":
      return {
        file: null,
        content: "",
        deps: [],
        registryItems: [],
        env: [],
        steps: [
          `The eve channel (agent/channels/eve.ts) already serves HTTP; build a frontend with useEveAgent`,
        ],
      };
    case "none":
    default:
      return {
        file: null,
        content: "",
        deps: [],
        registryItems: [],
        env: [],
        steps: [`No chat surface yet — add one later with: kyb add channel <slack|imessage|telegram|discord|web>`],
      };
  }
}

// ── Host ────────────────────────────────────────────────────────────────

export type HostKind = "vercel" | "exe";

export function hostAgentTs(host: HostKind, model: string): string {
  if (host === "exe") {
    return `import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { exeModel } from "@kybernesis/exe";

// Model served by the exe.dev LLM integration — no provider key on the host.
// exe injects the credential (managed gateway, your API key, or a connected
// ChatGPT subscription) server-side.
export default defineAgent({
  model: exeModel({ model: process.env.EXE_MODEL ?? ${JSON.stringify(model)}, createOpenAI }),
  modelContextWindowTokens: 200_000,
});
`;
  }
  return `import { defineAgent } from "eve";

export default defineAgent({
  model: ${JSON.stringify(model)},
});
`;
}

export function hostSteps(host: HostKind, name: string): string[] {
  if (host === "exe") {
    return [
      `Create the VM:  ssh exe.dev new --name ${name}`,
      `Attach an LLM integration (ChatGPT subscription, your API key, or exe's gateway):`,
      `    ssh exe.dev integrations setup chatgpt --name work   # once, device-code`,
      `    ssh exe.dev integrations edit llm --openai=chatgpt --openai-account=work`,
      `Install Node 24 + deps on the VM, then: npx eve build && bash scripts/eve-server.sh start`,
      `\`eve start\` does NOT read .env.local — scripts/eve-server.sh loads it for you`,
    ];
  }
  return [
    `vercel link  (the client's team), then set envs (prod/preview Sensitive)`,
    `npx eve deploy`,
  ];
}
