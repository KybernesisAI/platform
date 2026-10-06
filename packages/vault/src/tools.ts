import { fillOnComputer, type FillField } from "@kybernesis/computer";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  NO_PERSON,
  listItems,
  materialize,
  personFromContext,
  sameSite,
  valuesOf,
  type PrincipalContext,
  type VaultClientOptions,
} from "./client.js";

/** What the person has that could apply here. Labels and handles only. */
export function listVaultTool(options: VaultClientOptions = {}) {
  return defineTool({
    description:
      "List the signed-in person's saved logins, cards and addresses that apply to a site: labels, usernames, card brand and last four. Never the secrets. Give the page URL you are on so logins are filtered to that site.",
    inputSchema: z.object({
      page_url: z.string().url().optional().describe("The page open in your browser; logins are filtered to its site."),
    }),
    async execute(input, ctx) {
      const user = personFromContext(ctx as PrincipalContext);
      if (!user) return { items: [], note: NO_PERSON };
      const items = await listItems(options, user, input.page_url);
      return {
        items: items.map((i) => ({ id: i.id, kind: i.kind, label: i.label, site: i.origin, ...i.summary })),
        note: items.length ? "Use fill_from_vault with an item id and the selectors of the fields you can see." : "Nothing saved for this site. The person can add it in KYBER Studio under Settings → Vault.",
      };
    },
  });
}

const fieldSchema = z.object({
  field: z
    .string()
    .min(1)
    .max(40)
    .describe("Which value: username, password, number, cvc, expiration (MM/YY), expiration_long (MM/YYYY), exp_month, exp_year, name/cardholder, or an address/contact key like line1, city, postal_code, email, phone."),
  selector: z.string().min(1).max(500).describe("CSS selector of that input on the page."),
  frameUrl: z.string().url().optional().describe("If the input is inside an iframe, that frame's URL prefix."),
});

/**
 * Type a vault item into the page open on the agent's computer. The secret
 * goes control plane → page; the model sees which selectors were filled.
 *
 * Guards: a login only fills on the site it was saved for (a password typed
 * into a look-alike is the whole phishing problem), and a card asks the
 * person first — logging in is what they saved the login for, spending is a
 * decision each time.
 */
export function fillFromVaultTool(options: VaultClientOptions = {}) {
  return defineTool({
    description:
      "Type a saved login, card or address from the person's vault into the form open in your own browser. Give the item id (from list_vault), the page URL as shown, and the CSS selector for each field you can see. The values never come back to you; the result says which selectors were filled. A login only fills on its own site. Take a screenshot afterwards before submitting.",
    inputSchema: z.object({
      item_id: z.string().min(1).max(200),
      page_url: z.string().url(),
      fields: z.array(fieldSchema).min(1).max(12),
      submit: z.boolean().optional().describe("Press the form's submit after filling. Default false: look first."),
    }),
    approval: async (ctx) => {
      // Spending needs a yes each time; signing in is what the person saved the
      // login for. If anything about the question fails, ask.
      try {
        const user = personFromContext(ctx as unknown as PrincipalContext);
        const id = (ctx.toolInput as { item_id?: string } | undefined)?.item_id;
        if (!user || !id) return "user-approval";
        const items = await listItems(options, user);
        const item = items.find((i) => i.id === id);
        if (!item) return "user-approval";
        return item.kind === "card" ? "user-approval" : "not-applicable";
      } catch {
        return "user-approval";
      }
    },
    async execute(input, ctx) {
      const user = personFromContext(ctx as PrincipalContext);
      if (!user) throw new Error(NO_PERSON);
      const item = await materialize(options, user, input.item_id);
      if (item.kind === "login" && !sameSite(item.origin, input.page_url)) {
        throw new Error(`That login was saved for ${item.origin}, and this page is ${new URL(input.page_url).origin}. It will not be typed into a different site. If this really is the same service, tell the person; they can save a login for this site.`);
      }
      const values = valuesOf(item);
      const fields: FillField[] = [];
      const unknown: string[] = [];
      for (const f of input.fields) {
        const value = values[f.field];
        if (value === undefined) {
          unknown.push(f.field);
          continue;
        }
        fields.push({ selector: f.selector, value, ...(f.frameUrl ? { frameUrl: f.frameUrl } : {}) });
      }
      if (!fields.length) throw new Error(`None of those field names exist on this ${item.kind}: ${unknown.join(", ")}. Available: ${Object.keys(values).join(", ")}.`);
      const sandbox = await ctx.getSandbox();
      const result = await fillOnComputer(sandbox, { pageOrigin: new URL(input.page_url).origin, fields, submit: input.submit ?? false });
      return {
        ok: result.ok,
        item: { id: item.id, kind: item.kind, label: item.label },
        filled: result.filled,
        missing: result.missing,
        ...(unknown.length ? { unknown_fields: unknown } : {}),
        note: result.ok ? "Filled. Take a screenshot and check before you submit." : "Some selectors were not found on the page; look again and correct them.",
      };
    },
  });
}
