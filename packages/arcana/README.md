# @kybernesis/arcana

Kybernesis **Arcana long-term memory** for [eve](https://eve.dev) agents.

Mounting this extension gives an agent a durable workspace brain — timeline,
entity graph, fact store, semantic search, and a `brain/` notes directory —
plus the skills and always-on instructions that make the agent actually *use*
it: recall-first lookups, proactive fact storage, and two-step brain notes.

## What ships in the package

- `@kybernesis/arcana/memory` — `arcanaMemory()`, an eve 0.49 memory provider (see below).

| Contribution | What it does |
| --- | --- |
| `connections/memory` | MCP connection to `https://mcp.arcana.kybernesis.ai/mcp` (static-key auth + the required `X-Kyberagent-Agent` workspace header) |
| `skills/recall` | Entity/timeline/semantic retrieval playbook |
| `skills/remember` | Proactive fact storage, tagging, correction detection |
| `skills/brain-note` | Long-form notes: `brain_write` **and** `brain_add`, always both |
| `instructions.md` | Always-on memory rules: recall-first, never claim ignorance without searching, proactive remember, no secrets in memory |

Tools surfaced to the model (remote names): `arcana_recall`, `arcana_search`,
`arcana_timeline`, `arcana_remember`, `arcana_brain_list/read/write/add/query`,
and more. See [Tool naming](#tool-naming) for how names are qualified.

## Prerequisites

1. **An Arcana workspace** and a **`kb_` API key** for it (from
   [arcana.kybernesis.ai](https://arcana.kybernesis.ai)). Keys are
   **workspace-scoped**: a key for one workspace gets `403` on any other.
   One brain per mount → one workspace + one key per mount.
2. **eve `>= 0.29`** in the consuming agent.
3. Validate the key before wiring anything (read-only):

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer kb_..." \
  -H "X-Kyberagent-Agent: <workspace-slug>" \
  "https://api.arcana.kybernesis.ai/brain/<workspace-slug>/timeline?limit=1"
# expect HTTP 200
```

## Install

From npm (once published):

```bash
npm install @kybernesis/arcana
```

From a monorepo workspace (this repo checked out under `packages/arcana`):

```jsonc
// consuming agent package.json
{
  "workspaces": ["packages/*"],
  "dependencies": { "@kybernesis/arcana": "*" }
}
```

Then `npm install`. Under `eve dev`, workspace-mounted extensions rebuild
automatically when their source changes.

## Mount it

Create one file in the consuming agent. The **filename is the mount
namespace** (here: `arcana`):

```ts
// agent/extensions/arcana.ts
import arcana from "@kybernesis/arcana";

export default arcana({
  apiKey: process.env.ARCANA_API_KEY!,
  workspace: "my-company",
});
```

That's the whole integration: connection, skills, and memory instructions are
now part of the agent.

### Config reference

| Option | Type | Required | Purpose |
| --- | --- | --- | --- |
| `apiKey` | `string` | yes | The workspace's `kb_` key. Read it from an env var — never hardcode. |
| `workspace` | `string` | yes | Arcana workspace slug this brain reads/writes. |
| `resolveWorkspace` | `(ctx) => string \| undefined` | no | Per-session workspace override, resolved at runtime. Return `undefined` to fall back to `workspace`. |

`resolveWorkspace` example — route DM sessions to a different brain than
public-channel sessions (pair it with a verified session attribute your
channel stamps; never key it off model output):

```ts
export default arcana({
  apiKey: process.env.ARCANA_API_KEY!,
  workspace: "my-company",
  resolveWorkspace: (ctx) =>
    ctx.session.auth.current?.attributes.surface === "dm"
      ? "my-company-dm"
      : undefined,
});
```

> **Scoped-key caveat:** `resolveWorkspace` may only select workspaces the
> configured `apiKey` can reach — with workspace-scoped keys, keep one mount
> per workspace instead. And it must derive **only from verified session
> context** (`ctx.session.auth` attributes stamped by route/channel auth),
> never from model output or message text.

## Environment variables

Local dev reads `.env.local`; deployed agents read Vercel envs. Set both:

```bash
echo 'ARCANA_API_KEY="kb_..."' >> .env.local

vercel env add ARCANA_API_KEY production   # mark Sensitive
vercel env add ARCANA_API_KEY preview      # mark Sensitive
vercel env add ARCANA_API_KEY development  # (Sensitive not supported on dev)
```

Note: `eve deploy` runs `vercel env pull`, which **overwrites `.env.local`**
from the development environment — so the Vercel env is the source of truth;
put real values there.

## Deploy

```bash
npm run typecheck && npx eve info   # expect 0 errors / 0 warnings
npx eve deploy
```

Two rules that save hours:

1. **Deployed surfaces (e.g. Slack) run the deployed build** — redeploy after
   every change, or you'll debug stale code.
2. Memory failures are graceful: a missing/invalid key surfaces as a tool
   error the model reports, never a crash. If memory "doesn't work" after
   deploy, check the env vars in the target environment first.

## eve memory slot (eve ≥ 0.49)

eve 0.49 added first-class memory: a slot file names a provider, eve resolves
who the memory belongs to from trusted session context, calls the provider to
**recall** before the model sees a turn and to **capture** after it answers,
and mounts the provider's tools as `<slot>__<tool>`. Arcana ships as such a
provider, so an agent gets recall-before-every-turn without a skill telling
the model to go and look:

```ts title="agent/memory/arcana.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { arcanaMemory } from "@kybernesis/arcana/memory";

export default defineMemory({
  description: "Durable company memory in Arcana.",
  provider: arcanaMemory({
    apiKey: process.env.ARCANA_API_KEY!,
    workspace: process.env.ARCANA_COMPANY_WORKSPACE!,
  }),
  scope: byPrincipal,
});
```

What the provider does, and the two defaults that differ from the hosted
providers eve documents:

| Phase | Behaviour |
| --- | --- |
| `recall` (turn.started) | `arcana_search` + `arcana_brain_query` for the message, delivered as **one keyed message** eve replaces each turn. **Skipped for turns under 4 words** — a "hi" must not fan out to memory (the reference eval suite gates exactly that). A memory outage is logged and the turn goes on. |
| `capture` (turn.completed) | **Off by default.** Kybernesis agents remember deliberately through `arcana_remember` (the remember skill); capturing every turn on top would store each fact twice. `capture: { enabled: true }` for an agent with no remember skill that should learn passively. Captured memories carry `eve-memory`, `scope:<key>` and `op:<operationId>` tags. |
| `tools()` | `remember`, `recall`, `search` as `<slot>__*`. Set `tools: false` when the extension is also mounted — it already offers the full `arcana_*` set. |

Options: `url` (the MCP endpoint), `recall: { enabled, minWords, limit (default 3), brainNotes }`,
`capture: { enabled, minWords }`, `tools`, `resolveWorkspace(ctx)` (choose the
brain per operation from VERIFIED session context, as the extension does), `log`.

Arcana partitions by **workspace**, not by eve's scope: one `kb_` key reaches
one brain. The scope eve resolved is recorded as a tag on captured memories and
keys the recalled message, so attribution follows the principal, but isolation
between principals is the workspace's job. Slots and the extension mount can
coexist; they are independent surfaces over the same brain.

## Subagents (departments / multiple brains)

Declared subagents mount extensions locally (eve ≥0.30): drop a mount file
under `agent/subagents/<id>/extensions/` and only that subagent receives the
connection, skills, and instructions — one brain per department, each with its
own workspace-scoped key:

```ts
// agent/subagents/finance/extensions/arcana.ts
import arcana from "@kybernesis/arcana";

export default arcana({
  apiKey: process.env.ARCANA_FINANCE_API_KEY ?? "",
  workspace: "my-company-finance",
});
```

The root agent receives nothing from a subagent mount (and vice versa) —
subagents inherit nothing, so each department declares its own.

Alternatively, a plain connection file works when you want per-subagent auth
without the extension's skills/instructions:

```ts
// agent/subagents/finance/connections/arcana.ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.arcana.kybernesis.ai/mcp",
  description:
    "The finance team's long-term memory (Arcana): remember, recall, search, timeline, and brain notes.",
  auth: {
    getToken: async () => {
      const token = process.env.ARCANA_FINANCE_API_KEY;
      if (!token) throw new Error("ARCANA_FINANCE_API_KEY is not set.");
      return { token };
    },
  },
  headers: { "X-Kyberagent-Agent": "my-company-finance" },
});
```

With the plain-connection form, copy the three skills from `extension/skills/`
into the subagent's `skills/` directory if the subagent should carry the
playbooks too — the extension-mount form ships them automatically.

## Tool naming

Qualified tool names compose **mount namespace → connection name → remote
tool name**. Mounted as an extension (`extensions/arcana.ts`, root or
subagent), the connection is `arcana__memory` and tools surface as e.g.
`arcana__memory__arcana_remember`. A plain connection named `arcana`
surfaces `arcana__arcana_remember`.

Therefore: in approval policies, hooks, and evals, **match by remote-name
suffix** (`toolName.endsWith("arcana_remember")`), never by exact prefix —
your matching then survives any mounting style.

## Testing / hermetic evals

Point eval runs at a dedicated workspace so test data never lands in a real
brain. Pattern: create an `<agent>-eval` workspace + key, then override the
env at eval time:

```jsonc
// package.json
"scripts": {
  "eval": "ARCANA_COMPANY_WORKSPACE=my-company-eval eve eval"
}
```

…and have the mount file choose workspace/key from those env vars. Assert
memory behavior in evals by suffix (see [Tool naming](#tool-naming)).

## Security

What this extension does and does not touch:

- **Where memory lives.** Everything the agent remembers is stored in your
  Arcana workspace (`arcana.kybernesis.ai`) — timeline, entities, facts,
  embeddings, and `brain/` notes. Treat workspace contents with the same
  sensitivity as the conversations that produced them.
- **Key handling.** The `kb_` API key is resolved in the eve **app runtime**
  and attached to outbound MCP requests there. It is never part of model
  context, never serialized into session history, and never enters the
  sandbox. Store it as a Sensitive environment variable; rotate it from the
  Arcana dashboard (update the env var and redeploy).
- **Blast radius.** Keys are workspace-scoped — a leaked key exposes exactly
  one workspace and 403s everywhere else. Prefer one workspace + one key per
  brain (per agent, per subagent) over account-wide keys.
- **What the model controls.** The model chooses memory *content* (what to
  remember, what to search). It cannot choose the workspace or the key —
  both come from mount config resolved in the app runtime, keyed off
  verified session context when `resolveWorkspace` is used. Never derive a
  workspace from model output or message text.
- **Data hygiene.** The shipped instructions forbid storing passwords,
  access tokens, payment data, private keys, and one-time codes. This is an
  instruction-level guard, not a filter — add an `approval` gate on write
  tools if your deployment needs a hard control.
- **Multi-user surfaces.** On shared surfaces (a public Slack channel),
  anything stored is recallable by anyone who can talk to that brain. Split
  workspaces per audience (see `resolveWorkspace`) when that matters.

## Why static keys (and not OAuth)

Vercel Connect's interactive OAuth is currently broken for deployed agents
(the authorization link dies with "we couldn't find this authorization
request"), and declared-subagent sessions carry no user principal to bind a
grant to. Static workspace-scoped keys work identically in the dev TUI and in
production, with no sign-in flow. This is a deliberate design choice, not a
shortcut.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `missing auth — Bearer + X-Kyberagent-Agent required` | workspace header missing | The connection always sends it — check you're on this package's connection, not a hand-rolled one |
| `HTTP 403` from Arcana | key is scoped to a different workspace | Use that workspace's own key (or an account-wide key) |
| `HTTP 404` from Arcana | workspace doesn't exist | Create it in Arcana first |
| Agent refuses "remember this" / suggests reminders | memory instructions not loaded | Confirm the mount file exists and `eve info` shows the extension; redeploy |
| Works in `eve dev`, not in Slack | stale deploy or env var missing in production | `npx eve deploy`; check `vercel env ls` |
| Recall misses a *just*-stored fact | indexing latency in a cold workspace | Retry after ~20–30s |

## Development (this repo)

```bash
npm install
npm run build       # eve extension build → dist/extension
npm run typecheck
```

Ship `dist/` only (`files: ["dist"]`). The canonical dev copy lives in the
Kybernesis agent monorepo under `packages/arcana`; sync to this repo with:

```bash
git subtree push --prefix=packages/arcana git@github.com:KybernesisAI/arcana-eve.git main
```
