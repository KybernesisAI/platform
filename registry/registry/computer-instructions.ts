import { defineInstructions } from "eve/instructions";
import { COMPUTER_INSTRUCTIONS } from "@kybernesis/computer";

// The "which surface" rule: connected app, then a tool, then the agent's
// browser, then the person's machine. One source for every agent.
export default defineInstructions({ content: COMPUTER_INSTRUCTIONS });
