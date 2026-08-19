# @kybernesis/exe

Run [eve](https://eve.dev) agents on exe.dev VMs with subscription-backed model
access, process supervision, and an optional Slack binding.

## Run an agent as a service

Deployed agents should run under their installed systemd service so they start
again after a VM reboot.

Unlike `eve dev`, `eve start` does not load `.env.local` itself. The service
must export the file's assignments before starting the agent:

```bash
set -a
. ./.env.local
set +a
npx eve start
```

Merely sourcing the file creates shell variables that may not be inherited by
the child process. `set -a` marks assignments for export, and `set +a` restores
the shell's normal behavior afterward. Put production-only variables directly
in the systemd unit rather than in `.env.local`.

Once the unit exists, restart the agent through the service instead of running
`scripts/eve-server.sh` independently. Running both gives two supervisors
control of the same agent and can start two servers against the same durable
`.eve` store.

## Workflow callback base preflight

`hostPreflight()` checks `WORKFLOW_LOCAL_BASE_URL` when it is set: it trims the
value, removes one trailing slash, and sends a GET to `<base>/eve/v1/health`
from this machine. The check fails on a network error, on a 15-second timeout,
or on any non-2xx response.

The variable is the base for every workflow queue delivery, including the ones
the host makes to itself — not only for callbacks from remote work. A URL that
remote peers can reach but the host cannot therefore fails every queue delivery
and stops the agent from processing workflow work at all, while looking correct
in the environment file. The preflight exists because that failure names
`fetch failed` and nothing else.

## Models on a client's own subscription

Three providers, one purpose: a client already pays for a seat, and an agent
that bills metered API usage on top buys the same capability twice.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { createAnthropic } from "@ai-sdk/anthropic";
import { claudeSubscription, CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW } from "@kybernesis/exe";

export default defineAgent({
  model: claudeSubscription({ model: "claude-opus-5", createAnthropic }),
  modelContextWindowTokens: CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW,
});
```

`grokSubscription()` and eve's `experimental_chatgpt()` are the same idea for
their vendors, and all three read a login rather than an API key.

Claude differs in one way that matters operationally. Grok and ChatGPT
credentials are files a CLI keeps fresh; a Claude subscription is refreshed by a
**local proxy** that owns the OAuth exchange, so there is a process to keep
alive rather than only a file to keep current. `claudeSubscription()` speaks the
ordinary Anthropic Messages API to that proxy, and the API key it passes is a
placeholder the proxy replaces — a real key there would bill metered usage and
quietly defeat the whole arrangement.

**The proxy must bind to loopback.** It spends a paid subscription and requires
no credential of its own, so a port on a public interface is an open gateway to
that subscription. `claudeSubscription()` refuses a non-loopback URL unless
`requireLoopback: false` is passed deliberately, and preflight reports both
liveness and exposure:

```ts
await hostPreflight({ claudeProxyUrl: "http://127.0.0.1:3333/v1" });
```

Setting up the proxy, including a required patch that keeps Anthropic's
provider-defined tool names intact, is documented in [`patches/`](./patches).
Selecting between providers at boot — one env var, one stable context window per
process — is the pattern to copy; switching per turn would change the context
window under a running session.
