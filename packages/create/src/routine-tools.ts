import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dim, green } from "./util.js";

/**
 * The routine tools: create_routine, list_routines, delete_routine.
 *
 * They are files of the `manage` registry item, so every agent built since
 * they joined it (2026-10-17) has them, and every one built before does not:
 * asked in chat for something every morning, those agents had nothing to make
 * a routine with. `kyb upgrade` adds them to an agent that has manage and no
 * create_routine, the same files the registry writes (a test keeps the two
 * byte-identical). An agent with its own create_routine is never touched.
 */
export const ROUTINE_TOOL_FILES: ReadonlyArray<{ target: string; content: string }> = [
  { target: "agent/lib/routines.ts", content: "import { readFileSync } from \"node:fs\";\nimport { join } from \"node:path\";\nimport { routineTools } from \"@kybernesis/manage\";\n\n// The agent's own routines, shared by create_routine, list_routines and\n// delete_routine. Same file-writing path as Studio's schedule route, so a\n// routine made by asking and one made from Studio are the same source file.\n//\n// The restart that makes a new routine live is read from agent/channels/kyb.ts,\n// the one place `kyb init` and install-service.sh keep it, so the two can never\n// disagree. Without one, a routine is written but only goes live at the next\n// restart, and the tool says so instead of claiming it is set.\nconst appRoot = process.env.EVE_APP_DIR ?? process.cwd();\n\nfunction restartCommand(): string | undefined {\n  try {\n    const source = readFileSync(join(appRoot, \"agent/channels/kyb.ts\"), \"utf8\");\n    const literal = /^\\s*restartCommand:\\s*(\"(?:[^\"\\\\]|\\\\.)*\")/m.exec(source)?.[1];\n    return literal ? (JSON.parse(literal) as string) : undefined;\n  } catch {\n    return undefined;\n  }\n}\n\nexport const routines = routineTools({ appRoot, restartCommand: restartCommand() });\n" },
  { target: "agent/tools/create_routine.ts", content: "import { defineTool } from \"eve/tools\";\nimport { z } from \"zod\";\nimport { routines } from \"../lib/routines.js\";\n\n// \"Remind me every morning at 8\" needs something behind it, or the agent\n// confirms a routine that does not exist.\nexport default defineTool({\n  description: routines.create_routine.description,\n  inputSchema: z.object({\n    name: z.string().describe(\"Short name, e.g. 'morning brief'\"),\n    cron: z.string().describe(\"5-field cron: every day at 10am is `0 10 * * *`\"),\n    instruction: z.string().describe(\"What to do each time, written to yourself with enough context to act on alone\"),\n    // Studio and the phone unless the person names somewhere else for it to post.\n    deliver_to: z\n      .object({\n        surface: z.enum([\"studio\", \"buzz\", \"slack\", \"imessage\"]).describe(\"studio (the default), buzz, slack or imessage\"),\n        channel: z.string().optional().describe(\"For buzz or slack: the channel, e.g. '#dev', or its id\"),\n      })\n      .optional()\n      .describe(\"Only when the user names where the answer should go. Leave it out for KYBER Studio and the phone.\"),\n  }),\n  // ctx carries who asked, so the routine runs as them (their calendar, their phone).\n  execute: (input, ctx) => routines.create_routine.execute(input, ctx),\n  // The person sees a routine card; the model reads the result without it.\n  toModelOutput: routines.create_routine.toModelOutput,\n});\n" },
  { target: "agent/tools/list_routines.ts", content: "import { defineTool } from \"eve/tools\";\nimport { z } from \"zod\";\nimport { routines } from \"../lib/routines.js\";\n\nexport default defineTool({\n  description: routines.list_routines.description,\n  inputSchema: z.object({}),\n  execute: () => routines.list_routines.execute(),\n});\n" },
  { target: "agent/tools/delete_routine.ts", content: "import { defineTool } from \"eve/tools\";\nimport { z } from \"zod\";\nimport { routines } from \"../lib/routines.js\";\n\nexport default defineTool({\n  description: routines.delete_routine.description,\n  inputSchema: z.object({ name: z.string() }),\n  execute: (input) => routines.delete_routine.execute(input),\n});\n" },
];

/** Add the routine tools when this agent has manage and no create_routine. Returns the files written. */
export function repairRoutineTools(cwd: string, deps: Record<string, string>): string[] {
  if (!deps["@kybernesis/manage"]) return [];
  if (existsSync(join(cwd, "agent/tools/create_routine.ts"))) return [];
  const written: string[] = [];
  for (const file of ROUTINE_TOOL_FILES) {
    const path = join(cwd, file.target);
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
    written.push(file.target);
  }
  if (written.length > 0) {
    console.log(`  ${green("+")} Routines: ${written.join(", ")} ${dim("— asked for something every morning, the agent can now set it up")}`);
    console.log(`    ${dim("Takes effect after the next build and restart.")}\n`);
  }
  return written;
}
