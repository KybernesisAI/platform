import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routineTools } from "@kybernesis/manage";

// The agent's own routines, shared by create_routine, list_routines and
// delete_routine. Same file-writing path as Studio's schedule route, so a
// routine made by asking and one made from Studio are the same source file.
//
// The restart that makes a new routine live is read from agent/channels/kyb.ts,
// the one place `kyb init` and install-service.sh keep it, so the two can never
// disagree. Without one, a routine is written but only goes live at the next
// restart, and the tool says so instead of claiming it is set.
const appRoot = process.env.EVE_APP_DIR ?? process.cwd();

function restartCommand(): string | undefined {
  try {
    const source = readFileSync(join(appRoot, "agent/channels/kyb.ts"), "utf8");
    const literal = /^\s*restartCommand:\s*("(?:[^"\\]|\\.)*")/m.exec(source)?.[1];
    return literal ? (JSON.parse(literal) as string) : undefined;
  } catch {
    return undefined;
  }
}

export const routines = routineTools({ appRoot, restartCommand: restartCommand() });
