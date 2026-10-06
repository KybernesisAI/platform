# @kybernesis/payments

A Link wallet for an eve agent, on its owner's behalf.

Stripe's Link eve integration gives an agent `link__create_spend_request` and
friends: the agent names a merchant and a total, the person approves it in the
Link app, and Link issues a one-time card for exactly that purchase. This
package adds the two pieces that make it usable by a Kybernesis agent:

- **`linkTool(name)`** — Link's tool catalog (`@stripe/link-sdk/tools`) as eve tools, one per file. `create_spend_request` asks the person in eve before Link asks them again; every result is stripped of card fields.
- **`linkCliAuth()`** — the owner's `link-cli` sign-in as the agent's wallet
  credential. The owner runs `npx link-cli auth login --client-name <agent>` on
  the agent's host once (a device-code flow approved in the Link app); the CLI
  keeps and refreshes the tokens in its own config file, and this provider reads
  that file for each call. No token in env, none in source. Single-owner by
  design: this is a personal agent paying from its owner's wallet.
- **`payOnComputerTool()`** (`pay_on_computer`) — once a spend request is
  approved, types the one-time card into the checkout form open in the agent's
  own browser via `@kybernesis/computer`'s fill primitive. The model supplies CSS
  selectors; the card goes Link → page and comes back only as brand + last four.

```ts title="agent/tools/create_spend_request.ts"
import { linkTool } from "@kybernesis/payments";
export default linkTool("create_spend_request"); // one file per Link tool; see LINK_TOOL_NAMES
```

```ts title="agent/tools/pay_on_computer.ts"
import { payOnComputerTool } from "@kybernesis/payments";
export default payOnComputerTool();
```

`PAYMENTS_INSTRUCTIONS` is the order of operations the agent follows: agree the
exact total from the real checkout page, create one spend request, send the
approval link, wait, fill, screenshot, submit, report with `link__create_report`.

## Requirements

- `@kybernesis/computer` ≥ 0.2.0 mounted as the root sandbox (that is where the
  browser is).
- `link-cli` signed in on the host. Without it every wallet tool fails with a
  message saying exactly that; the agent cannot complete the sign-in itself.
- The install is `eve add @kybernesis/payments` from the Kybernesis registry.

## Gotchas

- Stripe's own eve extension (`@stripe/link-integrations-eve`, built with eve 0.66) does not mount on eve 0.68 — that is why the tools are wrapped here from the SDK instead.
- Link may require 3-D Secure or a verification step the agent cannot complete.
  The instructions tell it to stop and describe the screen; the person can take
  over the computer.
