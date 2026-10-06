import { payOnComputerTool } from "@kybernesis/payments";

// Types the one-time card of an APPROVED spend request into the checkout open
// in the agent's own browser. The card goes Link → page; the model only learns
// which fields were filled.
export default payOnComputerTool();
