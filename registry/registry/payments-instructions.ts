import { defineInstructions } from "eve/instructions";
import { PAYMENTS_INSTRUCTIONS } from "@kybernesis/payments";

// Agree the exact total first, ask (spend request), wait for Link's approval,
// fill the card without seeing it, screenshot, submit, report.
export default defineInstructions({ content: PAYMENTS_INSTRUCTIONS });
