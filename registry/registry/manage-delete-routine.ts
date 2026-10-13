import { defineTool } from "eve/tools";
import { z } from "zod";
import { routines } from "../lib/routines.js";

export default defineTool({
  description: routines.delete_routine.description,
  inputSchema: z.object({ name: z.string() }),
  execute: (input) => routines.delete_routine.execute(input),
});
