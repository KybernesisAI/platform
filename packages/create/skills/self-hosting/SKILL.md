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
kyb init <name> --host=exe --channel=<imessage|slack|telegram|none> --engineer --studio
kyb register        # control plane: device flow, grants you, idempotent by name
kyb deploy          # copy + install + restart, and prove it took
kyb doctor          # preflight; it knows the self-hosted failure modes below
```

`--host=exe` swaps the bindings and installs `scripts/eve-server.sh` — the
restart script, with every lesson below already in it. `--studio` adds local
execution and the management routes.

**Deploying is `kyb deploy`, not a hand-rolled rsync.** It refuses to copy
`node_modules` (native modules built on a laptop do not run on the host) or
`.eve` (the durable store — copying over it eats production state), restarts
detached so a dropped connection cannot SIGHUP the restart halfway, and waits
for the script to report health rather than reporting success on exit code.

## What Vercel gives you that a client host does not

| Capability | On Vercel | Self-hosted replacement |
| --- | --- | --- |
| Model access | AI Gateway | exe.dev LLM integration (`exeModel`) — managed, BYO key, or a **ChatGPT / Grok subscription** |
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

## Running on the client's own subscription

A client who already pays for ChatGPT Plus/Pro or SuperGrok / X Premium+ can
run the agent on it instead of on metered API billing. Both work the same way:
a CLI performs a device login on the host, writes a credential to the home
directory, and that credential is a valid bearer for an OpenAI-compatible
endpoint. eve ships `experimental_chatgpt()` for the first;
`@kybernesis/exe` ships `grokSubscription()` for the second.

```bash
# on the host, as the user the agent runs as
curl -fsSL https://x.ai/cli/install.sh | bash
grok login          # device flow → ~/.grok/auth.json
```

```ts title="agent/agent.ts"
import { createOpenAI } from "@ai-sdk/openai";
import { grokSubscription } from "@kybernesis/exe";

export default defineAgent({
  model: grokSubscription({ model: "grok-4.6", createOpenAI }),
  modelContextWindowTokens: 400_000,
});
```

What this arrangement costs you, and it is worth saying to the client:

- **It is per-machine and per-user.** The login belongs to the host's home
  directory. Moving the agent means logging in again; running it as a different
  unix user means it cannot see the credential at all.
- **The token expires in hours** (Grok: six) and the CLI refreshes it in place.
  Read it per request, never once at boot, or the agent works all afternoon and
  starts failing authentication at dinner for no reason a user can see.
- **Nobody has proven unattended refresh over days.** If no one runs `grok` on
  that host, whether the refresh keeps happening is an open question — and it
  presents as the agent "breaking".
- **Ask the vendor's terms question before a client demo**, not after.

## The failure modes, each of which cost a real session

- **Model ids carry a provider prefix**: `openai/gpt-5.6-sol`, not
  `gpt-5.6-sol`. Get them from `curl https://llm.int.exe.xyz/models.json` on
  the host, and note its `preferred_model`.
- **An unknown model id on the responses surface returns**
  `404 unsupported endpoint: /v1/responses` — an error about the ENDPOINT for
  a problem with the MODEL. The endpoint is fine. Check the prefix before
  believing that 404; chasing it cost hours and produced two wrong fixes.
- **Subscription-backed models are Responses-API only.** models.json reports
  `"apis": ["openai_responses"]`, and chat-completions answers `Model … is
  not in this integration's model list` for a model that plainly is listed.
- **Evals must run ON the host.** `llm.int.exe.xyz` is internal to exe.dev, so
  a laptop cannot reach it — every model call fails with a connection error to
  the cloud metadata address, which looks like a broken agent and is not.
- **An integration has to be attached to the VM** (`integrations attach llm
  <vm>`, or `auto:all`). Check with `ssh exe.dev integrations list`.

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

## Third-party APIs: version pinning and spec-derived calls

Two failures here cost most of a day on the first deployment. Both look like
outages or permission problems and are neither.

**Pin the API version the SPEC describes, not the one in a doc example.**
Notion's OpenAPI spec describes their current API (`/v1/data_sources/…`), but
eve's docs example pins `Notion-Version: 2022-06-28`, where that endpoint does
not exist. The mismatch returns `invalid_request_url`, `service_unavailable`
(503) on search, and "not shared with the integration" — three different lies,
none of them about the actual problem. Verify by making the SAME call the agent
makes, headers included.

**When the agent and your manual test disagree, the difference between the two
requests IS the bug.** Diff them at the first contradiction. Repeatedly proving
"the token works" with a hand-written curl while the agent fails proves nothing
if your curl sends a different version header.

**An agent's error message is a hypothesis, not evidence.** It will confidently
report an outage or a permissions problem it has not verified. Read the actual
request and response before acting — and never change a client's permissions on
an agent's say-so.

**Large specs with ambiguous ID schemes need a purpose-built tool, not a raw
connection.** Notion's spec is ~1.2MB and splits `database_id` from
`data_source_id` for the same board; a model deriving calls from it picks the
wrong one. Pin the endpoint and the IDs in a small tool
(`agent/tools/<domain>.ts`), keep the generic connection for the long tail, and
point the instructions at the tool.

**Credential brokering (exe http-proxy) is the right default off-Vercel:**

```
integrations add http-proxy --name <svc> --target https://api.example.com \
  --header 'Authorization:Bearer <token>' --header '<Version-Header>:<value>' \
  --attach vm:<vm>
```

Use `--header` for the token, not `--bearer=-`: the stdin form mangles it and
the API answers 401 "token is invalid".

## Restarts must be proven, not assumed

A restart that silently fails leaves the agent serving a stale build — new
connections, tools, and instructions never appear, and every later test measures
yesterday's agent. Assert the process started AFTER the build it should serve
(`scripts/eve-server.sh` and the restart pattern in `@kybernesis/exe` do this).
Related: a long-lived channel session caches the compiled agent, so start a
fresh conversation after changing capabilities.

A restart script also has to **serialize** (`flock`, released by the child with
`9>&-`) and **wait for in-flight turns** — eve does not resume a step killed
mid-flight, and restarting into a live turn strands the session behind a turn
that will never finish.

Run restarts **detached** from your ssh connection —
`setsid nohup bash restart.sh >/tmp/r.log 2>&1 </dev/null &` — or a dropped
connection SIGHUPs the script halfway through and leaves exactly the mess it
exists to prevent.

**Build before you restart.** Proving the process started after the build says
nothing about whether the build reflects the source — an agent served a build ten
hours older than its files while reporting success. It also breaks installs:
`@kybernesis/manage` writes files and then calls the restart script.

**And measure it correctly.** `pgrep -f 'server/index.mjs'` typed over ssh
matches the shell running it: the pattern is in that shell's own command line,
so it reports two servers when there is one. A whole investigation went into a
phantom "second server" that `ps -eo pid,ppid,args` would have dismissed
immediately. Inside a script file it is safe; typed at a shell it is not. List
the matches before you believe the count.
