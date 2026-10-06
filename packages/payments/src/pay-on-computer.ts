import { Link } from "@stripe/link-sdk";
import { fillOnComputer, type FillField } from "@kybernesis/computer";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { linkCliAuth, type LinkCliAuthOptions } from "./link-cli-auth.js";

const fieldSchema = z.object({
  field: z.enum(["name", "number", "exp_month", "exp_year", "expiration", "cvc", "postal_code"]),
  selector: z.string().min(1).max(500).describe("CSS selector of that input on the checkout page."),
  frameUrl: z.string().url().optional().describe("If the input lives in an iframe (common for card fields), that frame's URL prefix."),
  format: z.enum(["MM/YY", "MM/YYYY"]).optional().describe("For a combined expiration field."),
});

/**
 * Type the one-time card of an APPROVED Link spend request into a checkout
 * form on the agent's own computer. The card number and CVC go from Link to
 * the page and nowhere else: not into this tool's result, not into the
 * transcript, not into a screenshot caption.
 *
 * Eve's approval is deliberately `never()` here — the money decision already
 * happened twice: the agent asked eve's user approval to create the spend
 * request, and the person approved the purchase in Link. Filling the card for
 * a request that is not approved is refused.
 */
export function payOnComputerTool(options: LinkCliAuthOptions = {}) {
  const auth = linkCliAuth(options);
  return defineTool({
    description:
      "Type the one-time card from an APPROVED Link spend request into the checkout form open in your own browser. Give the CSS selector of each card field you can see (name, number, expiration or exp_month/exp_year, cvc, postal code). The card details never come back to you; the result says which fields were filled. Open the checkout with open_browser first and look at it.",
    inputSchema: z.object({
      spend_request_id: z.string().min(1).max(200),
      page_url: z.string().url().describe("The checkout page's URL, as shown in the browser."),
      fields: z.array(fieldSchema).min(2).max(7),
    }),
    approval: never(),
    async execute(input, ctx) {
      const { token } = await (auth as { getToken(o: unknown): Promise<{ token: string }> }).getToken({});
      const link = new Link({ accessToken: token });
      const request = await link.spendRequests.retrieve(input.spend_request_id, { include: ["card"] });
      if (!request) throw new Error("That spend request does not exist.");
      if (request.status !== "approved") {
        throw new Error(`Spend request is ${request.status}, not approved. Send the approval link and wait for the person to approve it in Link.`);
      }
      const card = (request as unknown as { card?: { number: string; cvc?: string; exp_month: number; exp_year: number; billing_address?: { name?: string; postal_code?: string } } }).card;
      if (!card) throw new Error("Link did not return a card for this request; it may need a different credential type.");
      const yy = String(card.exp_year).slice(-2);
      const mm = String(card.exp_month).padStart(2, "0");
      const values: Record<string, string | undefined> = {
        name: card.billing_address?.name,
        number: card.number,
        exp_month: mm,
        exp_year: String(card.exp_year),
        cvc: card.cvc,
        postal_code: card.billing_address?.postal_code,
      };
      const fields: FillField[] = [];
      for (const f of input.fields) {
        const value = f.field === "expiration" ? (f.format === "MM/YYYY" ? `${mm}/${card.exp_year}` : `${mm}/${yy}`) : values[f.field];
        if (value === undefined) continue;
        fields.push({ selector: f.selector, value, ...(f.frameUrl ? { frameUrl: f.frameUrl } : {}) });
      }
      const sandbox = await ctx.getSandbox();
      const result = await fillOnComputer(sandbox, { pageOrigin: new URL(input.page_url).origin, fields });
      return {
        ok: result.ok,
        filled: result.filled.length,
        missing: result.missing,
        card: { brand: (card as { brand?: string }).brand ?? "card", last4: card.number.slice(-4) },
        note: result.ok
          ? "Card details are in the form. Take a screenshot, check the totals match the spend request, then submit the order and report the outcome with create_report."
          : "Some fields could not be found; look at the page again and correct the selectors.",
      };
    },
  });
}
