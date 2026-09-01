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

// Same reasoning as the root brain: no placeholder. A subagent quietly
// addressing a workspace nobody owns is amnesia that looks like a model
// problem rather than a missing value. Set it with \`kyb arcana\`.
const workspace = process.env.ARCANA_${upper}_WORKSPACE;
if (!workspace) {
  throw new Error(
    "ARCANA_${upper}_WORKSPACE is not set — run \`kyb arcana\` to set this subagent workspace and key.",
  );
}

export default defineMcpClientConnection({
  url: "https://mcp.arcana.kybernesis.ai/mcp",
  description:
    "The ${dept} team's long-term memory (Arcana): remember, recall, search, timeline, and brain notes.",
  auth: {
    getToken: async () => {
      // The eval brain is a DIFFERENT workspace, so it needs its own key —
      // Arcana keys answer 403 outside the workspace they were minted for.
      // Recognised by name rather than by suffix: an eval workspace does not
      // have to be called "<agent>-eval", and matching on the suffix sends a
      // custom one through the company key, where every memory eval fails with
      // a 403 that reads as the agent's memory being broken.
      // Falls back to the old suffix rule when nothing names the eval brain, so
      // an agent written before this variable existed keeps working untouched.
      const evalWorkspace = process.env.ARCANA_EVAL_WORKSPACE;
      const isEval = evalWorkspace
        ? workspace === evalWorkspace
        : workspace.endsWith("-eval");
      const token =
        (isEval ? process.env.ARCANA_EVAL_API_KEY : undefined) ??
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
// No placeholder fallback. A default here does not prevent a mistake, it
// hides one: memory silently addresses a workspace nobody owns, and the agent
// looks like it has amnesia rather than like it is misconfigured. Set with
// \`kyb arcana\`.
const COMPANY = process.env.ARCANA_COMPANY_WORKSPACE;
if (!COMPANY) {
  throw new Error(
    "ARCANA_COMPANY_WORKSPACE is not set — run \`kyb arcana\` to set the workspace and its key.",
  );
}
const DM = process.env.ARCANA_DM_WORKSPACE ?? COMPANY;

// Same rule as the department connections: the eval brain is named, not
// guessed from a suffix.
// Falls back to the old suffix rule when nothing names the eval brain, so an
// agent written before this variable existed keeps working untouched.
const EVAL = process.env.ARCANA_EVAL_WORKSPACE;
const IS_EVAL = EVAL ? COMPANY === EVAL : COMPANY.endsWith("-eval");

export default arcana({
  apiKey:
    (IS_EVAL ? process.env.ARCANA_EVAL_API_KEY : undefined) ??
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

/**
 * Env every self-hosted agent needs and cannot infer.
 *
 * Both of these have bitten a real deployment. EXE_MODEL must match the LLM
 * integration actually attached — a ChatGPT subscription serves OpenAI models,
 * so an Anthropic code default fails against it. EXE_VM_NAME has no default at
 * all by design: guessing a host would hand a user a working link into another
 * agent's machine.
 */
function exeEnvBlock(name: string, model: string): string {
  return `# Self-hosted host + model (@kybernesis/exe)
# EXE_MODEL must match the LLM integration you attached to the VM. A ChatGPT
# subscription serves OpenAI models; the code default will fail against one.
# Set it explicitly rather than relying on ${model}.
EXE_MODEL="${model}"
# Preview URLs are built from this. There is no default on purpose.
EXE_VM_NAME="${name}"

`;
}

export function envExample(
  name: string,
  depts: string[],
  issuer: string,
  channelEnv: string[] = [],
  host: "vercel" | "exe" = "vercel",
  model = "",
): string {
  const deptVars = depts
    .map((d) => {
      const upper = d.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      return `# ARCANA_${upper}_API_KEY="kb_..."\n# ARCANA_${upper}_WORKSPACE="${name}-${d}"`;
    })
    .join("\n");
  const header =
    host === "exe"
      ? `# Real values live in .env.local ON THE HOST. \`eve start\` does NOT read it the
# way \`eve dev\` does — scripts/eve-server.sh exports it into the process.`
      : `# Real values belong in Vercel envs (prod/preview Sensitive); \`eve deploy\`
# overwrites .env.local from the development environment on every deploy.`;
  return `# ── Kybernesis agent environment ─────────────────────────────────────
${header}

# Control-plane governance (@kybernesis/enterprise)
KYBERNESIS_ISSUER="${issuer}"
KYBERNESIS_AGENT="${name}"

${host === "exe" ? exeEnvBlock(name, model) : ""}${channelEnv.length ? `# Channel\n${channelEnv.join("\n")}\n\n` : ""}# Arcana memory (@kybernesis/arcana) — one workspace + scoped kb_ key per brain
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
      `Install Node 24 + deps on the VM, fill .env.local, then install the production service:`,
      `    bash node_modules/@kybernesis/exe/scripts/install-service.sh`,
      `The systemd unit exports .env.local, builds before every start, and is the single supervisor`,
    ];
  }
  return [
    `vercel link  (the client's team), then set envs (prod/preview Sensitive)`,
    `npx eve deploy`,
  ];
}

// ── Engineer subagent ───────────────────────────────────────────────────
// `--engineer` scaffolds a DECLARED SUBAGENT that owns the build capability,
// rather than granting it to the root agent. The root stays whatever it is to
// the client (assistant, chief of staff); only the builder gets shell, a
// browser, and a sandbox. Subagents own their own sandbox — they do NOT
// inherit the root's — so the workshop is written into the subagent.

export interface EngineerPlan {
  files: Array<{ path: string; content: string }>;
  deps: string[];
  steps: string[];
}

/** The workshop sandbox, per host. Same recipe; different backend. */
function workshopSandbox(host: HostKind): string {
  if (host === "exe") {
    return `import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

/**
 * The engineer workshop, self-hosted: pnpm + Playwright + Chromium baked into
 * the TEMPLATE so warm sessions run render→screenshot→vision in seconds.
 *
 * Docker rather than vercel(): the hosted backend needs Vercel OIDC, which does
 * not exist off-Vercel.
 *
 * HOST PREREQUISITE: some images ship Docker disabled (exe.dev's exeuntu runs
 * \`systemctl disable docker.service\`). Run \`sudo systemctl enable --now docker\`
 * or every build fails with SandboxTemplateNotProvisionedError.
 *
 * NOTE: Docker sessions do not enforce a domain allowlist the way the hosted
 * backend does. Egress control is the HOST's responsibility here — a deliberate
 * difference from the Vercel deployment, not an oversight.
 */
export default defineSandbox({
  backend: docker(),
  revalidationKey: () => "kybernesis-workshop-v5-docker",
  async bootstrap({ use }) {
    const sandbox = await use();
    // Base image is Debian-family; refresh indexes before installing browser deps.
    await sandbox.run({ command: "apt-get update" });
    await sandbox.run({ command: "npm install -g pnpm" });
    // Explicit package.json rather than \`npm init -y\`: init derives the name from
    // the directory, and npm rejects names starting with a dot (".shot").
    await sandbox.run({
      command:
        "mkdir -p /workspace/.shot && cd /workspace/.shot && echo '{\\"name\\":\\"kyb-shot\\",\\"private\\":true}' > package.json && npm install playwright",
    });
    await sandbox.run({
      command: "cd /workspace/.shot && npx playwright install --with-deps chromium",
    });
  },
});
`;
  }
  return `import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * The engineer workshop: a warm, safe cloud dev machine.
 *
 * TEMPLATE bootstrap (once, inherited by every session): pnpm + Playwright +
 * Chromium. Prewarm runs at deploy time, so a broken bootstrap fails the build
 * loudly and warm sessions run the full render→screenshot→vision loop in
 * seconds. Backend PINNED to Vercel Sandbox — hosted sandboxes even from local
 * dev (run \`vercel link\` + \`vercel env pull\` first), so evals exercise the
 * exact production backend. No Docker anywhere.
 *
 * All sessions run under a domain ALLOWLIST: an agent that installs arbitrary
 * npm packages must not have open egress. A blocked domain fails loudly;
 * treat every addition as a security decision.
 */
export default defineSandbox({
  backend: vercel({
    resources: { vcpus: 4 },
    networkPolicy: {
      allow: [
        "registry.npmjs.org",
        "*.npmjs.org",
        "github.com",
        "api.github.com",
        "codeload.github.com",
        "*.githubusercontent.com",
        "cdn.playwright.dev",
        "playwright.azureedge.net",
        "playwright.download.prss.microsoft.com",
        "storage.googleapis.com",
        "archive.ubuntu.com",
        "security.ubuntu.com",
        "ports.ubuntu.com",
        "*.ubuntu.com",
        "deb.debian.org",
        "security.debian.org",
        "*.debian.org",
        "ai-gateway.vercel.sh",
        "vercel.com",
        "*.vercel.app",
        "fonts.googleapis.com",
        "fonts.gstatic.com",
      ],
    },
  }),
  revalidationKey: () => "kybernesis-workshop-v5",
  async bootstrap({ use }) {
    const sandbox = await use();
    // The egress proxy carries HTTPS only; apt defaults to http:// mirrors, so
    // every index fetch silently fails. Rewrite to https first.
    await sandbox.run({
      command:
        "find /etc/apt -type f \\\\( -name '*.list' -o -name '*.sources' \\\\) -exec sed -i 's|http://|https://|g' {} + && apt-get update",
    });
    await sandbox.run({ command: "npm install -g pnpm" });
    await sandbox.run({
      command:
        "mkdir -p /workspace/.shot && cd /workspace/.shot && echo '{\\"name\\":\\"kyb-shot\\",\\"private\\":true}' > package.json && npm install playwright",
    });
    await sandbox.run({
      command: "cd /workspace/.shot && npx playwright install --with-deps chromium",
    });
  },
});
`;
}

export function engineerPlan(host: HostKind, model: string): EngineerPlan {
  const onExe = host === "exe";
  const files: EngineerPlan["files"] = [
    {
      path: "agent/subagents/builder/agent.ts",
      content: onExe
        ? `import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { exeModel } from "@kybernesis/exe";

// The specialist the root agent delegates BUILDING to. \`description\` is what
// the root routes on — keep it about building, not answering.
export default defineAgent({
  description:
    "Builds and runs software: scaffolds projects, writes code, installs dependencies, runs builds and dev servers, and visually verifies rendered pages. Use when the user asks for something to be BUILT, prototyped, deployed, or fixed in code — not for questions, planning, or scheduling.",
  model: exeModel({ model: process.env.EXE_MODEL ?? ${JSON.stringify(model)}, createOpenAI }),
  modelContextWindowTokens: 200_000,
});
`
        : `import { defineAgent } from "eve";

// The specialist the root agent delegates BUILDING to. \`description\` is what
// the root routes on — keep it about building, not answering.
export default defineAgent({
  description:
    "Builds and runs software: scaffolds projects, writes code, installs dependencies, runs builds and dev servers, and visually verifies rendered pages. Use when the user asks for something to be BUILT, prototyped, deployed, or fixed in code — not for questions, planning, or scheduling.",
  model: ${JSON.stringify(model)},
});
`,
    },
    {
      path: "agent/tools/deliver.ts",
      content: `// Handing a file to the person you are talking to.
//
// The engineer layer mounts on \`builder\`, so building stays there — but
// DELIVERING is not building. It reads one file from this agent's own sandbox
// and copies it to storage, runs no commands and writes nothing back, and the
// agent that needs it is the one talking to the user.
//
// Without this the root is told (by its instructions, and by our own playbook)
// to deliver files and has no such tool. It cannot detect the mismatch, so it
// promises a file and then quietly puts the contents somewhere nobody can
// reach — a memory note, or an apology with no cause given.
export { deliver as default } from "@kybernesis/engineer/tools";
`,
    },
    {
      path: "agent/subagents/builder/extensions/engineer.ts",
      content: `// Engineer layer mounted LOCALLY on this subagent (eve >=0.30): screenshot,
// deliver, and the trade-school skills belong to \`builder\` alone, so the root
// gets no shell ON THE HOST and none of the build loop.
//
// Not "the root has no shell" — every eve agent has a sandbox with bash,
// read_file, write_file, glob and grep, and this app builds two templates
// (root and builder). The root's shell is its own container. The distinction
// that matters is host access, and the old wording blurred exactly the line
// people read this comment to understand.
//
// The root DOES get a browser and GitHub tools — the engineer layer installs
// extension/agent-browser and extension/github-tools at the root, deliberately,
// because reading a page is not the same blast radius as running a command.
export { default } from "@kybernesis/engineer";
`,
    },
    {
      path: "agent/subagents/builder/sandbox/sandbox.ts",
      content: workshopSandbox(host),
    },
  ];

  if (onExe) {
    files.push({
      path: "agent/subagents/builder/hooks/sandbox-cleanup.ts",
      content: `export { terminalSandboxCleanupHook as default } from "@kybernesis/exe/sandbox-cleanup";\n`,
    });
  }

  if (onExe) {
    files.push({
      path: "agent/subagents/builder/tools/preview.ts",
      content: `export { previewTool as default } from "@kybernesis/exe/preview";
`,
    });
  }

  return {
    files,
    deps: onExe ? ["@kybernesis/engineer", "@kybernesis/exe"] : ["@kybernesis/engineer"],
    steps: onExe
      ? [
          "Enable Docker on the host (some images ship it disabled): sudo systemctl enable --now docker",
          "Preview server (so the agent can show you what it built):\n       mkdir -p ~/preview && setsid python3 -m http.server 3456 --directory ~/preview &\n       then open https://<vm>.exe.xyz:3456/<file> (account-gated, not public)",
          "File delivery needs object storage: set BLOB_READ_WRITE_TOKEN (Vercel Blob) or DELIVER_DIR + DELIVER_BASE_URL to serve from this host",
          "Public deploys need the client's own Vercel token — Vercel Connect does NOT work off-Vercel",
        ]
      : [
          "File delivery: vercel blob create-store <name>-deliverables --access public --yes",
          "Preview deploys: eve add connection/vercel, then vercel connect create mcp.vercel.com --name vercel && vercel connect attach mcp.vercel.com/vercel --yes",
        ],
  };
}


/**
 * The eval judge, for an exe.dev host.
 *
 * Without this the judge resolves through Vercel's AI Gateway and fails with
 * "Unauthenticated request to AI Gateway" on a host that has no gateway key
 * and does not need one — the agent passes every gate the judge is not part
 * of, which reads as a half-broken agent rather than a missing config.
 *
 * Judged by a DIFFERENT provider from the one under test. A model grading its
 * own output is a weak test, and the Anthropic path is a plain Messages
 * endpoint, so none of the subscription backend's constraints apply.
 */
export function exeEvalConfigTs(): string {
  return `import { defineEvalConfig } from "eve/evals";
import { createAnthropic } from "@ai-sdk/anthropic";

const exe = createAnthropic({
  baseURL: process.env.EXE_LLM_URL ?? "https://llm.int.exe.xyz/v1",
  apiKey: "exe-integration",
});

export default defineEvalConfig({
  // A different provider from the agent under test, on purpose.
  // Verified against the exe integration rather than assumed: it validates model
  // names and refuses one it does not carry, so a stale default here fails the
  // whole suite at the judge rather than at anything the agent did.
  judge: { model: exe(process.env.EXE_JUDGE_MODEL ?? "claude-sonnet-5") },
  // Real model and real memory on every turn: generous timeout, gentle concurrency.
  timeoutMs: 300_000,
  maxConcurrency: 1,
});
`;
}
