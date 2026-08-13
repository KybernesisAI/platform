import { readFileSync, existsSync } from "node:fs";
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
const index = JSON.parse(readFileSync(join(root, "r", "registry.json"), "utf8"));

let failures = 0;
const fail = (message) => {
  console.error(`✗ ${message}`);
  failures += 1;
};

if (!Array.isArray(index.items) || !index.items.length) fail("registry.json has no items");

for (const item of index.items ?? []) {
  if (!item.name) fail("an item has no name");
  if (!item.description) fail(`${item.name}: no description`);

  const itemPath = join(root, "r", `${item.name}.json`);
  if (!existsSync(itemPath)) {
    fail(`${item.name}: r/${item.name}.json is missing, so \`eve add\` cannot fetch it`);
    continue;
  }

  const full = JSON.parse(readFileSync(itemPath, "utf8"));
  for (const file of full.files ?? []) {
    if (!file.target) fail(`${item.name}: a file has no target`);
    if (!file.content) fail(`${item.name}: ${file.target} has no content to install`);
    if (file.path && !existsSync(join(root, file.path))) {
      fail(`${item.name}: source ${file.path} does not exist`);
    }
  }

  // The index carries pointers, not payloads: inlining content there would
  // double every edit and let the two copies drift.
  for (const file of item.files ?? []) {
    if (file.content) fail(`${item.name}: registry.json should not inline file content`);
  }
}

console.log(
  failures ? `\n${failures} problem(s)` : `registry ok — ${index.items.length} items`,
);
process.exit(failures ? 1 : 0);
