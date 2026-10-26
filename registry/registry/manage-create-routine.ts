import { defineTool } from "eve/tools";
import { z } from "zod";
import { routines } from "../lib/routines.js";

// "Remind me every morning at 8" needs something behind it, or the agent
// confirms a routine that does not exist.
export default defineTool({
  description: routines.create_routine.description,
  inputSchema: z.object({
    name: z.string().describe("Short name, e.g. 'morning brief'"),
    cron: z.string().describe("5-field cron: every day at 10am is `0 10 * * *`"),
    instruction: z.string().describe("What to do each time, written to yourself with enough context to act on alone"),
  }),
  // ctx carries who asked, so the routine runs as them (their calendar, their phone).
  execute: (input, ctx) => routines.create_routine.execute(input, ctx),
  // The person sees a routine card; the model reads the result without it.
  toModelOutput: routines.create_routine.toModelOutput,
});
