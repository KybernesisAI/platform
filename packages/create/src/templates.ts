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

export function envExample(name: string, depts: string[], issuer: string): string {
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

# Slack (@kybernesis/multiplayer) — Vercel Connect connector UID
# SLACK_CONNECTOR_UID="slack/${name}"

# Arcana memory (@kybernesis/arcana) — one workspace + scoped kb_ key per brain
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
