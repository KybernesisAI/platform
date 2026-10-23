import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serve an eve line's registry items next to the current ones.
 *
 * The registry deploys from master, so the items a line branch carries
 * (`eve-0.81`) are invisible until that branch merges, and the root `/r/` must
 * keep serving the line every agent still runs. This copies the line branch's
 * items to `registry/r/<line>/`, where an agent on the new eve points its
 * `@kybernesis` registry: `https://registry.kybernesis.ai/r/<line>/{name}.json`.
 *
 * Every `@kybernesis/*` dependency gains the line's npm tag. Registry items
 * name packages bare, and a bare name installs `latest`, which stays on the old
 * line until cutover: a 0.81 item would install a 0.68 build. eve also skips a
 * bare dependency the agent already has, so only a specifier upgrades it.
 *
 * Rerun after any registry change on the line branch, then
 * `node scripts/check-registry.mjs`:
 *
 *   git fetch origin eve-0.81 && node scripts/line-registry.mjs eve-0.81
 *
 * Once the line has merged and master IS that line (eve-0.81 since
 * 2026-10-23), the items come from this checkout instead, so a new item on
 * master reaches the line's agents too:
 *
 *   node scripts/line-registry.mjs eve-0.81 .
 */
const line = process.argv[2] ?? "eve-0.81";
if (!/^eve-\d+\.\d+$/.test(line)) throw new Error(`not an eve line: ${line}`);
const ref = process.argv[3] ?? `origin/${line}`;

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "registry", "r", line);

const fromLine = (path) =>
  JSON.parse(
    ref === "."
      ? readFileSync(join(repo, path), "utf8")
      : execFileSync("git", ["show", `${ref}:${path}`], { cwd: repo, encoding: "utf8" }),
  );

const tagged = (deps) =>
  deps?.map((dep) => (/^@kybernesis\/[^@/]+$/.test(dep) ? `${dep}@${line}` : dep));

const withLineDeps = (item) => (item.dependencies ? { ...item, dependencies: tagged(item.dependencies) } : item);

const write = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");

mkdirSync(out, { recursive: true });
const catalog = fromLine("registry/r/registry.json");
for (const entry of catalog.items) {
  write(`${entry.name}.json`, withLineDeps(fromLine(`registry/r/${entry.name}.json`)));
}
write("registry.json", { ...catalog, items: catalog.items.map(withLineDeps) });

console.log(`${catalog.items.length} items from ${ref === "." ? "this checkout" : ref} → registry/r/${line}/`);
