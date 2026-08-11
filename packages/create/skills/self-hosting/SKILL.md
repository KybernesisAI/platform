---
description: Use when deploying an eve agent OFF Vercel — on exe.dev, a VPS, or any client infrastructure — or when a client wants to use their own ChatGPT/LLM subscription. Covers what breaks, what replaces it, and the credential checklist.
---

# Self-hosted agents (client infrastructure, not Vercel)

The Vercel path is the default and the proven one. Reach for this when the
client **won't or can't use Vercel**, or wants their agent's inference billed to
a subscription they already pay for.

**The governing rule: everything must come from the CLIENT's accounts.** If a
step only works because you happen to hold a credential, that step is a bug in
the deployment, not a shortcut. It will fail on the real engagement.

## Scaffold

```bash
kyb init <name> --host=exe --channel=<imessage|slack|telegram|none> --engineer
```

`--host=exe` swaps the bindings; everything else is the same product. Run
`kyb doctor` after — it knows the self-hosted failure modes below.

## What Vercel gives you that a client host does not

| Capability | On Vercel | Self-hosted replacement |
| --- | --- | --- |
| Model access | AI Gateway | exe.dev LLM integration (`exeModel`) — managed, BYO key, or a **ChatGPT subscription** |
| Slack/Photon/Linear credentials | Vercel Connect | **Portable/static credentials the client issues** |
| Sandbox | `vercel()` hosted | `docker()` on the host |
| File delivery | Vercel Blob | Blob **or** `DELIVER_DIR` + `DELIVER_BASE_URL` |
| Public URLs | deployments | a deploy target, or an account-gated preview |
| Secrets | Vercel env | host env + the platform's own secret injection |

**Vercel Connect does not work off-Vercel — at all.** It authenticates via
Vercel OIDC, which does not exist on another host. That applies to Slack, the
Vercel MCP connection, Linear, everything. Each becomes a static credential
someone must issue and rotate. `kyb doctor` fails loudly if a `@vercel/connect`
import survives into a self-hosted agent.

## The failure modes, each of which cost a real session

- **Docker ships disabled on some images.** exe.dev's exeuntu runs
  `systemctl disable docker.service`, so `docker --version` works while nothing
  can run. Every sandbox call fails with `SandboxTemplateNotProvisionedError`.
  Fix: `sudo systemctl enable --now docker`.
- **Subagents own their sandbox — they do NOT inherit the root's.** An engineer
  subagent without its own `sandbox/sandbox.ts` gets a bare template, and the
  screenshot tool fails with `Cannot find module 'playwright'` while the root's
  template is fine.
- **`eve start` does not read `.env.local`** the way `eve dev` does. Export it
  into the process (`scripts/eve-server.sh` in `@kybernesis/exe` does this).
- **Prewarm lives in the eve CLI, not the built server.** Starting
  `node .output/server/index.mjs` directly gives you clean logs but skips
  template prewarm entirely. Start with `npx eve start`.
- **`localDev()` never authenticates under `eve start`** — it is a property of
  the deployment, not the request. A self-hosted agent needs a real
  authenticator from day one.
- **`pkill -f <pattern>` over SSH kills your own session** when the pattern
  appears in the SSH command line — and can take the agent with it. Use a
  pidfile (`scripts/eve-server.sh`).
- **Never diagnose "nothing is happening" from a log file.** Count runs on disk:
  `.eve/.workflow-data/runs/`. A log can look frozen at boot while the agent
  serves happily.

## Showing the client what the agent built

- **Vercel Blob refuses to serve HTML inline** — it forces a download. Use it
  for documents and exports, never to show a web page.
- **exe.dev forwards ports 3000–9999** to `https://<vm>.exe.xyz:<port>/`, but a
  VM has exactly **one public port** and the agent's webhook already owns it.
  Alternate ports are account-gated: fine for the client reviewing work, not for
  the public.
- **Anything genuinely public needs a deploy target** — the client's own Vercel
  token, or their hosting. Treat "public" as a deploy step, not a toggle.
- A sandbox is a container: its ports are not reachable from the host, so a dev
  server inside it cannot be previewed directly. Copy the artifact out (the
  `preview` tool in `@kybernesis/exe`) or deploy it.

## Credential checklist — collect ALL of these from the client

Nothing here can be borrowed from another agent or another account.

1. **Host** — VM/server, plus the platform token if the agent provisions anything
2. **Model source** — their LLM API key, gateway allocation, or connected
   subscription (exe: `integrations setup chatgpt`, then `integrations edit llm`)
3. **Channel app** — their Slack app (bot + app token) / Photon project / bot token
4. **Arcana** — workspaces + scoped `kb_` keys (one per brain, plus `-eval`)
5. **Storage for deliverables** — their blob store, or a served host directory
6. **Deploy target** — their Vercel token or hosting, if the agent ships sites
7. **Control plane** — agent registered and the pilot cohort granted

## Before calling it done

`kyb doctor` green (or every warning consciously accepted), the eval suite green
against the client's `-eval` workspace, and a live turn on the real surface.
