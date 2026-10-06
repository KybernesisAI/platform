# @kybernesis/vault

The person's logins, cards and addresses, usable by their agent without ever
being read by it.

Items live in the Kybernesis control plane, added from KYBER Studio
(Settings → Vault, or a Chrome password CSV import). The summary half — label,
site, username, a card's brand and last four — is what an agent may list. The
secret half is sealed, and leaves the control plane through exactly one door: a
materialize call that carries the agent's credential AND the person's verified
principal, for one item, audited. The only caller of that door is
`fill_from_vault`, which types the value into the page open on the agent's own
computer (`@kybernesis/computer`'s DevTools fill) and returns which selectors
were filled. The value is never a tool result, so it is never in a transcript.

```ts title="agent/tools/list_vault.ts"
import { listVaultTool } from "@kybernesis/vault";
export default listVaultTool();
```

```ts title="agent/tools/fill_from_vault.ts"
import { fillFromVaultTool } from "@kybernesis/vault";
export default fillFromVaultTool();
```

## Who the vault belongs to

`personFromContext` is default-deny: only a turn whose verified principal came
from the control plane (`authenticator: "kybernesis"`, a `user`) has a vault.
Studio turns and linked chat senders qualify; schedules, eve's local-dev
principal and a channel's default principal do not, and get an empty list.

## Guards

- A **login** only fills on the site it was saved for (same registrable host or
  a subdomain of it). A password typed into a look-alike is the whole phishing
  problem, so the tool refuses rather than asking.
- A **card** requires the person's approval on every fill (eve `user-approval`).
- Every materialization writes an `audit_log` row naming the agent and the item.

## Env

`KYBERNESIS_ISSUER` (the control plane) and `KYBERNESIS_AGENT_CREDENTIAL` (this
agent's credential) — the same two every enterprise-governed agent already has.
