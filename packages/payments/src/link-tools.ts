import { Link } from "@stripe/link-sdk";
import { createLinkTools } from "@stripe/link-sdk/tools";
import { defineTool, type ToolDefinition } from "eve/tools";
import { always, never } from "eve/tools/approval";
import { linkCliAuth, type LinkCliAuthOptions } from "./link-cli-auth.js";

/**
 * Stripe's Link tools, mounted the Kybernesis way.
 *
 * Stripe ships an eve extension, but it is built against an older eve and
 * eve 0.68 refuses to mount it. The same tool catalog is available
 * framework-free from `@stripe/link-sdk/tools`, so each one is wrapped here as
 * an eve tool: the owner's link-cli sign-in supplies the token on every call,
 * creating a spend request asks the person in eve before it asks them in Link,
 * and anything that could carry a card number is stripped from what the model
 * sees — the card has exactly one path, `pay_on_computer`.
 */
export const LINK_TOOL_NAMES = [
  "retrieve_user_info",
  "list_payment_methods",
  "list_shipping_addresses",
  "list_spend_requests",
  "create_spend_request",
  "update_spend_request",
  "cancel_spend_request",
  "request_spend_approval",
  "retrieve_spend_request",
  "create_report",
] as const;
export type LinkToolName = (typeof LINK_TOOL_NAMES)[number];

/** A Link client whose token is the owner's current link-cli sign-in, read at call time. */
export function linkClient(options: LinkCliAuthOptions = {}): Link {
  const auth = linkCliAuth(options) as { getToken(o: unknown): Promise<{ token: string }> };
  return new Link({ getAccessToken: async () => (await auth.getToken({})).token });
}

/** Remove anything that is or contains a card credential before it reaches the model. */
export function sanitizeLinkOutput<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sanitizeLinkOutput(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "card" || k === "credential" || k === "number" || k === "cvc" || k === "payment_token" || k === "shared_payment_token") continue;
      out[k] = sanitizeLinkOutput(v);
    }
    return out as T;
  }
  return value;
}

type Catalog = ReturnType<typeof createLinkTools<unknown>>;

/**
 * One Link tool as an eve tool. Mount each in `agent/tools/<name>.ts`:
 *
 * ```ts
 * import { linkTool } from "@kybernesis/payments";
 * export default linkTool("create_spend_request");
 * ```
 */
export function linkTool<N extends LinkToolName>(name: N, options: LinkCliAuthOptions = {}): ToolDefinition<Record<string, unknown>, unknown> {
  const catalog: Catalog = createLinkTools(linkClient(options));
  const tool = catalog[name] as { description: string; inputSchema: Catalog[N]["inputSchema"]; execute(input: never, context: unknown): Promise<unknown> };
  return defineTool({
    description: tool.description,
    inputSchema: tool.inputSchema as never,
    // Asking Link for money starts with asking the person here. Reading and
    // reporting do not; Link's own approval step still gates every card.
    approval: name === "create_spend_request" ? always() : never(),
    async execute(input, ctx) {
      const result = await tool.execute(input as never, ctx);
      return sanitizeLinkOutput(result);
    },
  }) as unknown as ToolDefinition<Record<string, unknown>, unknown>;
}
