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
