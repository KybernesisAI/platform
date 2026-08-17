# @kybernesis/exe

Run [eve](https://eve.dev) agents on exe.dev VMs with model access, process
supervision, host preflight checks, and optional Slack integration.

## Workflow callback base preflight

When `WORKFLOW_LOCAL_BASE_URL` is non-empty after trimming, `hostPreflight()`
removes one trailing slash and sends a GET request from the self-hosted machine
to `<base>/eve/v1/health`. The check fails on a network error, after the
15-second timeout, or when the endpoint does not return a successful 2xx HTTP
response.

The value is the base for every framework workflow queue delivery, including
deliveries from the host to itself. A URL that remote peers can reach but the
host cannot causes queue delivery fetch failures and stops the agent from
processing workflow work; it does not only break remote callbacks.
