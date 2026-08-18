#!/usr/bin/env node
/**
 * Build every workspace package in dependency order.
 *
 * `npm run build --workspaces` runs packages in the order they appear on disk,
 * which is alphabetical — so `dispatch` compiled before `enterprise`, against a
 * sibling whose types did not exist yet. On a developer's machine that passes
 * forever, because a previous build left `dist/` sitting there; it only fails
 * on a clean checkout, which is to say only in CI and only for a newcomer.
 *
 * Peer dependencies count here. A package that imports a sibling but declares
 * it as a peer still needs that sibling BUILT first, even though npm has no
 * reason to install it first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const packages = new Map();
for (const dir of readdirSync("packages")) {
  const manifest = `packages/${dir}/package.json`;
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  packages.set(pkg.name, {
    dir,
    hasBuild: Boolean(pkg.scripts?.build),
    needs: [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ],
  });
}

const built = new Set();
const building = new Set();

function build(name) {
  if (built.has(name)) return;
  const pkg = packages.get(name);
  if (!pkg) return; // Not one of ours: npm already installed it.
  if (building.has(name)) {
    // A cycle cannot be ordered, and silently picking a side would produce the
    // same intermittent failure this script exists to remove.
    throw new Error(`Dependency cycle in the workspace, reached again at ${name}.`);
  }
  building.add(name);
  for (const dependency of pkg.needs) build(dependency);
  building.delete(name);
  built.add(name);
  if (!pkg.hasBuild) return;
  console.log(`building ${name}`);
  execFileSync("npm", ["run", "build", "-w", name], { stdio: "inherit" });
}

for (const name of packages.keys()) build(name);
