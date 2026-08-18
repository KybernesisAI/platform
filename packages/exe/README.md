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
