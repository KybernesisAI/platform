import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The registry is a published contract, edited by hand.
 *
 * `eve add @kybernesis/<name>` reads these files directly, so a malformed item
 * or a file pointer that does not resolve fails in a client's terminal during a
 * deployment — the worst possible place to discover a typo. Two packages have
 * already shipped without registry entries at all.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "registry");

let failures = 0;
const fail = (message) => {
  console.error(`✗ ${message}`);
  failures += 1;
};

// The root catalog, plus one per eve line served beside it (`r/eve-0.81/`,
// written by scripts/line-registry.mjs).
const lines = readdirSync(join(root, "r"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^eve-\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name);

let total = 0;
for (const line of [undefined, ...lines]) {
  const dir = line ? join(root, "r", line) : join(root, "r");
  const at = line ? `r/${line}/` : "r/";
  if (!existsSync(join(dir, "registry.json"))) {
    fail(`${at}registry.json is missing`);
    continue;
  }
  const index = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
  if (!Array.isArray(index.items) || !index.items.length) fail(`${at}registry.json has no items`);
  total += index.items?.length ?? 0;

  for (const item of index.items ?? []) {
    if (!item.name) fail("an item has no name");
    if (!item.description) fail(`${at}${item.name}: no description`);

    const itemPath = join(dir, `${item.name}.json`);
    if (!existsSync(itemPath)) {
      fail(`${at}${item.name}.json is missing, so \`eve add\` cannot fetch it`);
      continue;
    }

    const full = JSON.parse(readFileSync(itemPath, "utf8"));
    for (const file of full.files ?? []) {
      if (!file.target) fail(`${at}${item.name}: a file has no target`);
      if (!file.content) fail(`${at}${item.name}: ${file.target} has no content to install`);
      // A line's sources live on its branch, not here; its content is embedded.
      if (!line && file.path && !existsSync(join(root, file.path))) {
        fail(`${item.name}: source ${file.path} does not exist`);
      }
    }

    // A bare package name installs npm `latest`, which is the previous line
    // until cutover: a line item must ask for its own builds by tag.
    if (line) {
      for (const dep of [...(full.dependencies ?? []), ...(item.dependencies ?? [])]) {
        if (dep.startsWith("@kybernesis/") && !dep.endsWith(`@${line}`)) {
          fail(`${at}${item.name}: ${dep} would install latest, not the ${line} build`);
        }
      }
    }

    // The index carries pointers, not payloads: inlining content there would
    // double every edit and let the two copies drift.
    for (const file of item.files ?? []) {
      if (file.content) fail(`${at}${item.name}: registry.json should not inline file content`);
    }
  }
}

console.log(
  failures
    ? `\n${failures} problem(s)`
    : `registry ok — ${total} items${lines.length ? ` (lines: ${lines.join(", ")})` : ""}`,
);
process.exit(failures ? 1 : 0);
