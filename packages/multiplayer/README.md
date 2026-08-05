# @kybernesis/multiplayer

Multiplayer conversations for [eve](https://eve.dev) agents: one agent, many
verified speakers, shared threads that behave like a real group conversation —
extracted from the production Kybernesis company agent.

## What "multiplayer" means here

- **Thread = shared session.** A Slack thread maps to one durable eve session
  that multiple humans drive. Every message re-authenticates: `auth.current` is
  *that message's verified sender*; `auth.initiator` stays pinned to whoever
  started the thread.
- **Attributed context.** Thread messages between agent replies are injected
  with stable per-speaker Slack ids — the model sees a genuine multi-party
  transcript, not a blended blob.
- **No re-mentions.** Once the agent is active in a thread, anyone can keep
  talking to it. The thread becomes an N-way conversation among colleagues and
  the agent.
- **Dual surface.** Public-channel sessions carry a verified `surface:
  "channel"` principal attribute; DMs carry `surface: "dm"`. Your tools,
  approval policies, and dynamic resolvers gate on it (helpers included).
- **DM reset.** `/new` (configurable) retires a DM session and starts fresh.

## Install

```bash
npm install @kybernesis/multiplayer
```

Or via the Kybernesis registry (also writes the channel file and a multiplayer
instructions fragment):

```bash
eve registry add @kybernesis=https://registry.kybernesis.ai/r/{name}.json
eve add @kybernesis/multiplayer
```

## Usage

```ts
// agent/channels/slack.ts — the entire integration
import { multiplayerSlackChannel } from "@kybernesis/multiplayer/slack";
import { connectSlackCredentials } from "@vercel/connect/eve";

export default multiplayerSlackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR_UID!),
});
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `credentials` | — (required) | Slack credentials, e.g. `connectSlackCredentials("slack/<connector>")` |
| `continuation` | `"subscribed-threads"` | `"subscribed-threads"`: mentions + any message in an active thread. `"mention-only"`: explicit mentions only. Subscribed mode needs the `message.channels` trigger + `channels:history` scope on the connector (private channels: `message.groups` + `groups:history`). |
| `dmReset` | `"/new"` | DM command that starts a fresh session; `false` disables |
| `threadContext` | `"incremental"` | `"incremental"`: inject messages since the agent's last reply. `"full"`: whole thread each mention. `false`: triggering message only. Needs the matching history scope. |
| `events` | — | Event-handler overrides passed through to the underlying eve Slack channel |

### Surface helpers (package root)

```ts
import { sessionSurface, requireDm, slackUserIdOf } from "@kybernesis/multiplayer";
```

- `sessionSurface(ctx.session)` → `"channel" | "dm" | null` — gate anything on
  the surface (the `eve dev` local principal counts as `"dm"` so you can test
  personal capabilities locally).
- `requireDm(ctx.session)` — fail-closed guard for personal capabilities; the
  thrown message is model-visible ("DM me for that").
- `slackUserIdOf(ctx.session)` — the verified Slack user id of the current
  speaker.
- `withSurface(auth, surface)` / `surfaceOf(auth)` — the stamping primitives,
  if you author custom hooks.

Example — a personal tool that refuses to run in a shared channel:

```ts
import { defineTool } from "eve/tools";
import { requireDm } from "@kybernesis/multiplayer";

export default defineTool({
  description: "Read the caller's personal task list.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    requireDm(ctx.session); // throws a model-visible refusal on the channel surface
    // ...
  },
});
```

## Composes with

- **`@kybernesis/arcana`** — pair `sessionSurface` with Arcana's
  `resolveWorkspace` to give shared channels a company brain and DMs a separate
  workspace.
- **`@kybernesis/enterprise`** — control-plane governance on the HTTP door
  today; per-speaker grant gating and person-scoped approvals on the Slack door
  are the planned integration between these two packages.

## v1 caveats (read before enterprise rollout)

- **Approvals are session-scoped.** eve's HITL buttons render in the thread and
  any member can answer them. Fine for benign confirmations; do not gate
  destructive actions on thread-visible approvals in shared channels until
  person-scoped approvals ship.
- **Slack access = workspace membership.** Anyone in the workspace who can see
  the bot can talk to it. Per-user grant gating on the Slack door is a planned
  `@kybernesis/enterprise` module.
- **One turn at a time per session.** Messages arriving mid-turn are folded
  into the next turn best-effort (eve's delivery contract) — simultaneous
  speakers resolve in arrival order.
- Slack-only in v1. `/discord` and `/whatsapp` subpaths are reserved for the
  same core with thin per-channel adapters.
