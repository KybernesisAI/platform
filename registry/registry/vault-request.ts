import { requestVaultItemTool } from "@kybernesis/vault";

// Ask the person for a login, card or address that is not in their vault.
// Parks durably; Studio shows a form that saves to the vault and hands back an
// item id, other surfaces offer "I'll type it myself" or "Cancel". No secret
// ever passes through the agent.
export default requestVaultItemTool();
