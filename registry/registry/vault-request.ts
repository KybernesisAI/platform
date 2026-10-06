import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { REQUEST_VAULT_ITEM_DESCRIPTION, interpretVaultAnswer, vaultItemAsk } from "@kybernesis/vault";

// Ask the person for a login, card or address that is not in their vault.
// Parks durably; Studio shows a form that saves to the vault and hands back an
// item id, other surfaces offer "I'll type it myself" or "Cancel". No secret
// ever passes through the agent. Authored here, not in the package: eve
// compiles "use workflow" from the tool module's source.
export default defineWorkflowTool({
  description: REQUEST_VAULT_ITEM_DESCRIPTION,
  inputSchema: z.object({
    kind: z.enum(["login", "card", "address", "contact"]),
    site: z.string().url().optional().describe("The site the item is for, as shown in the browser."),
    label: z.string().max(80).optional().describe("A suggested label, e.g. the service name."),
    reason: z.string().max(200).optional().describe("One sentence on what you are trying to do."),
    fields: z.array(z.string()).max(12).optional().describe("The field names the page needs, if you can tell."),
  }),
  async execute(input, ctx) {
    "use workflow";
    const answer = await ctx.ask(vaultItemAsk(input));
    return interpretVaultAnswer(answer);
  },
});
