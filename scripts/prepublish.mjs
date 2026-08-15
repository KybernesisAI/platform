#!/usr/bin/env node
/**
 * Refuse to publish a version number that is already on npm.
 *
 * npm's own error for this only fires when the tarball is IDENTICAL enough to
 * be rejected outright; the dangerous case is quieter. Cut 0.7.9, publish it,
 * then keep editing — the source still says 0.7.9, every local check passes,
 * and the fix simply never reaches anyone. The failure surfaces days later as
 * "the command you told me about does nothing", and the natural conclusion is
 * that the install is stale rather than the release.
 *
 * So the rule is mechanical: a published version is frozen. Bump, then publish.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.private) process.exit(0);

let published = [];
try {
  published = JSON.parse(
    execFileSync("npm", ["view", pkg.name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch {
  // Never published, or npm is unreachable. A first publish must not be blocked
  // by a network hiccup, and npm itself still rejects a true duplicate.
  process.exit(0);
}

if ([].concat(published).includes(pkg.version)) {
  const latest = [].concat(published).at(-1);
  console.error(
    `\n  ${pkg.name}@${pkg.version} is already on npm — publishing it again cannot ship anything.\n` +
      `  Latest published: ${latest}\n\n` +
      `  Bump first:  npm version patch --no-git-tag-version\n`,
  );
  process.exit(1);
}
