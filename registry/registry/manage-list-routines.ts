import { defineTool } from "eve/tools";
import { z } from "zod";
import { routines } from "../lib/routines.js";

export default defineTool({
  description: routines.list_routines.description,
  inputSchema: z.object({}),
  execute: () => routines.list_routines.execute(),
});
