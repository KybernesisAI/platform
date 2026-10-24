#!/usr/bin/env node
/**
 * Publish every package whose version is not on npm yet, in one command.
 *
 *   cd ~/platform && npm run release            # publish
 *   cd ~/platform && npm run release -- --dry-run   # show what would go out
 *
 * A release used to be one pull, cd and publish block per package, plus a
 * second command per package for the eve-line dist-tag, typed in the right
 * order by hand. This does the same steps from clean master:
 *
 *   1. refuse on a dirty tree or a branch other than master, then fast-forward;
 *   2. `npm ci` (a package new to the workspace needs its link), build every
 *      workspace in dependency order, and check each package's eve line;
 *   3. publish each package whose version npm does not have, dependencies
 *      first, then point the eve-line tag (`eve-0.81`) at it, because line
 *      registry items install `@kybernesis/<pkg>@eve-<line>`;
 *   4. once everything is out, wait for the tarballs to be downloadable, and
 *      warn (never stop) about any npm is still slow to serve.
 *
 * npm still asks for browser 2FA on each publish and each tag. Never pass
 * --otp. A package npm has never seen can only be created by the account that
 * owns the scope; under any other login it is skipped and named at the end, and
 * running this again under that account publishes just what is left.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCOPE_OWNER = "kybernesis";
const REGISTRY = "https://registry.npmjs.org";
const dryRun = process.argv.includes("--dry-run");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const read = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fail = (message) => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

// 1. Clean master, current with origin.
if (read("git", ["status", "--porcelain"])) {
  fail("The working tree has changes. Commit or stash them first: what ships must match master.");
}
const branch = read("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "master") fail(`On branch ${branch}. Releases go out from master: git checkout master`);

if (!process.env.KYB_RELEASE_PULLED) {
  const before = read("git", ["rev-parse", "HEAD"]);
  run("git", ["pull", "--ff-only", "origin", "master"]);
  if (read("git", ["rev-parse", "HEAD"]) !== before) {
    // The pull may have changed this very script; run the version just pulled.
    try {
      run(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        env: { ...process.env, KYB_RELEASE_PULLED: "1" },
      });
      process.exit(0);
    } catch (error) {
      process.exit(error.status ?? 1);
    }
  }
}

// What npm already has, per package. A 404 means npm has never seen the name.
async function publishedVersions(name) {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) fail(`npm answered ${res.status} for ${name}; try again in a minute.`);
  return Object.keys((await res.json()).versions ?? {});
}

const packages = new Map();
for (const dir of readdirSync("packages")) {
  const manifest = `packages/${dir}/package.json`;
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.private) continue;
  packages.set(pkg.name, { dir, pkg });
}

const pending = [];
for (const [name, entry] of packages) {
  const versions = await publishedVersions(name);
  if (versions?.includes(entry.pkg.version)) continue;
  pending.push({ ...entry, name, isNew: versions === null });
}
if (pending.length === 0) {
  console.log("\n  Every package version on master is already on npm. Nothing to release.\n");
  process.exit(0);
}

// Dependencies first, the same rule the workspace build uses: a package goes
// out after every sibling it depends on, peers included.
const internal = (pkg) =>
  [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ].filter((dep) => packages.has(dep));
const pendingNames = new Set(pending.map((p) => p.name));
const ordered = [];
const placed = new Set();
const place = (item) => {
  if (placed.has(item.name)) return;
  placed.add(item.name);
  for (const dep of internal(item.pkg)) {
    if (pendingNames.has(dep)) place(pending.find((p) => p.name === dep));
  }
  ordered.push(item);
};
pending.forEach(place);

const lineOf = (version) => /^(\d+\.\d+)\./.exec(version)?.[1];
const eveVersion = /EVE_VERSION = "([^"]+)"/.exec(readFileSync("packages/create/src/util.ts", "utf8"))?.[1];
const lineTag = eveVersion ? `eve-${lineOf(eveVersion)}` : null;
if (!lineTag) fail("Could not read EVE_VERSION from packages/create/src/util.ts.");

let account = null;
try {
  account = read("npm", ["whoami"]);
} catch {
  if (!dryRun) fail("Not signed in to npm. Run npm login, then npm run release again.");
}
const canCreate = account === SCOPE_OWNER;

console.log(`\n  Release from master ${read("git", ["rev-parse", "--short", "HEAD"])}, npm account ${account ?? "(none)"}:`);
for (const item of ordered) {
  const note = item.isNew ? (canCreate ? " (new package)" : ` (new package: needs the ${SCOPE_OWNER} account)`) : "";
  console.log(`    ${item.name}@${item.pkg.version}${note}`);
}
console.log(`  Each one is also tagged ${lineTag}.\n`);
if (dryRun) process.exit(0);

// 2. Install, build and check what is about to ship.
run("npm", ["ci", "--no-audit", "--no-fund"]);
run("npm", ["run", "build"]);
run(process.execPath, [
  "scripts/check-eve-line.mjs",
  ...ordered.map((item) => `packages/${item.dir}/package.json`),
]);

// 3. Publish and tag. Nothing here waits on npm's CDN: a publish does not need its
// dependency's tarball to be downloadable, only an install does. Stopping on a slow
// tarball made every release a run, a wait and a rerun (2026-10-24).
async function tarballReady(name, version) {
  const base = name.split("/").pop();
  const res = await fetch(`${REGISTRY}/${name}/-/${base}-${version}.tgz?t=${Date.now()}`, { method: "HEAD" });
  return res.ok;
}

const done = [];
const skipped = [];
for (const item of ordered) {
  const id = `${item.name}@${item.pkg.version}`;
  const blockedBy = internal(item.pkg).find((dep) => skipped.some((s) => s.name === dep));
  if (item.isNew && !canCreate) {
    skipped.push({ name: item.name, id, why: `new package, only the ${SCOPE_OWNER} account can create it` });
    continue;
  }
  if (blockedBy) {
    skipped.push({ name: item.name, id, why: `depends on ${blockedBy}, which was skipped` });
    continue;
  }
  console.log(`\n  Publishing ${id}`);
  try {
    run("npm", ["publish"], { cwd: `packages/${item.dir}` });
  } catch {
    fail(`${id} did not publish. Everything before it is out; fix this and run npm run release again.`);
  }
  try {
    run("npm", ["dist-tag", "add", id, lineTag]);
  } catch {
    fail(`${id} is published but not tagged ${lineTag}. Run: npm dist-tag add ${id} ${lineTag}`);
  }
  done.push({ id, name: item.name, version: item.pkg.version });
}

// 4. Wait for the tarballs together, so consumers can install. Slow is a warning, not a failure.
const TARBALL_WAIT_MS = 10 * 60_000;
let waiting = [...done];
const started = Date.now();
if (waiting.length) console.log(`\n  Waiting for npm to serve ${waiting.length} tarball(s)…`);
while (waiting.length && Date.now() - started < TARBALL_WAIT_MS) {
  const ready = await Promise.all(waiting.map((d) => tarballReady(d.name, d.version).catch(() => false)));
  waiting = waiting.filter((_, i) => !ready[i]);
  if (waiting.length) await new Promise((resolve) => setTimeout(resolve, 10_000));
}

console.log("\n  Released:");
for (const { id } of done) console.log(`    ${id} (latest, ${lineTag})`);
if (done.length === 0) console.log("    nothing");
if (waiting.length > 0) {
  console.log("\n  Published, but npm is still slow to serve these (nothing to rerun; give it a few minutes before installing):");
  for (const { id } of waiting) console.log(`    ${id}`);
}
if (skipped.length > 0) {
  console.log("\n  Not released:");
  for (const s of skipped) console.log(`    ${s.id}: ${s.why}`);
  console.log(`\n  To finish: npm login as ${SCOPE_OWNER}, then npm run release again.`);
}
console.log("");
