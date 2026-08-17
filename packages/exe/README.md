# @kybernesis/exe

Run [eve](https://eve.dev) agents on exe.dev VMs with process supervision and
subscription-backed model access.

## Running as a service

The installed systemd unit is the agent's boot-time process supervisor. Its
start command must export values from `.env.local` before running `eve start`:

```bash
set -a
. ./.env.local
set +a
npx eve start
```

Sourcing the file alone creates ordinary shell variables, which child processes
do not inherit. `set -a` exports assignments as they are sourced so `eve start`
receives them; unlike `eve dev`, `eve start` does not load `.env.local` itself.
Keep production-only variables in the systemd unit environment rather than in
`.env.local`.

Once the unit exists, restart the agent with `systemctl restart <unit>`, not
`scripts/eve-server.sh`. Running both the restart script and the service creates
two supervisors that can start two processes against the same `.eve` durable
store.
