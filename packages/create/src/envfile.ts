import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Set values in a project's .env.local, replacing in place.
 *
 * Its own module because two commands need it and both were getting it wrong
 * in the same way: a registry item's `envVars` only appends NAMES, so a
 * scaffold could finish with `KYBERNESIS_AGENT=` empty and every later command
 * reading it would report the value as missing — which reads as a step the
 * person skipped rather than one they were never offered.
 */
export function upsertEnv(dir: string, values: Record<string, string>): void {
  const path = join(dir, ".env.local");
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}="${value}"`;
    const existing = new RegExp(`^${key}=.*$`, "m");
    if (existing.test(text)) {
      // A function replacer, never a string: `$&` and `` $` `` are special in a
      // replacement string, and a value containing either silently splices in
      // part of the file. That has happened twice, and both times it produced
      // a file that looked plausible and did not parse.
      text = text.replace(existing, () => line);
    } else {
      text += (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
    }
  }

  writeFileSync(path, text);
}
