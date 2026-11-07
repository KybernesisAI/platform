#!/usr/bin/env node
/**
 * Publish every package whose version is not on npm yet.
 *
 * It normally runs by itself: `.github/workflows/publish.yml` runs it on every
 * push to master (and to a `maint/eve-<line>` branch), so merging a version
 * bump IS the release. npm trusts that one workflow file (Trusted Publishing,
 * GitHub's short-lived OIDC identity), so no npm token exists anywhere and
 * nothing expires. Each version also gets a provenance statement linking it to
 * the commit it was built from.
 *
 * By hand it still works the old way, for the one thing CI cannot do (create a
 * package npm has never seen; only the scope owner can):
 *
 *   cd ~/platform && npm run release              # publish
 *   cd ~/platform && npm run release -- --dry-run # show what would go out
 *
 * The steps, either way:
 *
 *   1. refuse on a dirty tree or a branch that is not a release branch; by hand,
 *      fast-forward first;
 *   2. `npm ci`, build every workspace in dependency order, check each package's
 *      eve line (and, in CI, typecheck and test);
 *   3. publish each package whose version npm does not have, dependencies
 *      first. From master a publish moves `latest`, then the eve-line tag
 *      (`eve-0.81`) follows it, because line registry items and `kyb upgrade`
 *      install `@kybernesis/<pkg>@eve-<line>`. From `maint/eve-<line>` a publish
 *      moves only that line's tag and never `latest`;
 *   4. from master, catch up any eve-line tag left behind an already published
 *      master version (a tag step that failed or was skipped), never backwards;
 *   5. wait for the tarballs to be downloadable, and warn (never stop) about any
 *      npm is still slow to serve.
 *
 * By hand, npm asks for browser 2FA on each publish and each tag. Never pass
 * --otp.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCOPE_OWNER = "kybernesis";
const REGISTRY = "https://registry.npmjs.org";
const dryRun = process.argv.includes("--dry-run");
const ci = process.env.GITHUB_ACTIONS === "true";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const read = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const summary = (text) => {
  if (ci && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};
const fail = (message) => {
  console.error(`\n  ${message}\n`);
  if (ci) console.log(`::error::${message.replace(/\n/g, " ")}`);
  summary(`**Release stopped:** ${message}`);
  process.exit(1);
};
const again = ci ? "push a fix to rerun the release" : "fix this and run npm run release again";

// 1. A clean release branch, current with origin.
if (read("git", ["status", "--porcelain"])) {
  fail("The working tree has changes. Commit or stash them first: what ships must match the branch.");
}
const branch = ci ? process.env.GITHUB_REF_NAME : read("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const maintLine = /^maint\/(eve-\d+\.\d+)$/.exec(branch ?? "")?.[1] ?? null;
if (branch !== "master" && !maintLine) {
  fail(`On branch ${branch}. Releases go out from master, or from a maint/eve-<line> branch for an older line.`);
}

if (!ci && !process.env.KYB_RELEASE_PULLED) {
  const before = read("git", ["rev-parse", "HEAD"]);
  run("git", ["pull", "--ff-only", "origin", branch]);
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

// What npm already has, per package: its versions and dist-tags. A 404 means
// npm has never seen the name.
async function onNpm(name) {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) fail(`npm answered ${res.status} for ${name}; try again in a minute.`);
  const doc = await res.json();
  return { versions: Object.keys(doc.versions ?? {}), tags: doc["dist-tags"] ?? {} };
}

const packages = new Map();
for (const dir of readdirSync("packages")) {
  const manifest = `packages/${dir}/package.json`;
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.private) continue;
  packages.set(pkg.name, { dir, pkg });
}

const lineOf = (version) => /^(\d+\.\d+)\./.exec(version)?.[1];
const eveVersion = /EVE_VERSION = "([^"]+)"/.exec(readFileSync("packages/create/src/util.ts", "utf8"))?.[1];
const lineTag = eveVersion ? `eve-${lineOf(eveVersion)}` : null;
if (!lineTag) fail("Could not read EVE_VERSION from packages/create/src/util.ts.");
if (maintLine && maintLine !== lineTag) {
  fail(`Branch ${branch} certifies eve ${eveVersion} (${lineTag}), not ${maintLine}. Fix EVE_VERSION or the branch name.`);
}

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(/[.+-]/).slice(0, 3).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const pending = [];
const retag = [];
for (const [name, entry] of packages) {
  const npm = await onNpm(name);
  const { version } = entry.pkg;
  if (!npm?.versions.includes(version)) {
    pending.push({ ...entry, name, isNew: npm === null });
    continue;
  }
  // Published already. From master, the line tag must sit on it unless it is
  // somehow ahead (never move a tag backwards).
  const tagged = npm.tags[lineTag];
  if (!maintLine && tagged !== version && (!tagged || newer(version, tagged))) {
    retag.push({ name, id: `${name}@${version}`, from: tagged ?? "(none)" });
  }
}
if (pending.length === 0 && retag.length === 0) {
  console.log(`\n  Every package version on ${branch} is already on npm and tagged. Nothing to release.\n`);
  summary(`Nothing to release: every package version on \`${branch}\` is already on npm and tagged.`);
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

// In CI the identity is the workflow, not an account: it can publish new
// versions of packages that trust it, never create a package.
let account = null;
if (!ci) {
  try {
    account = read("npm", ["whoami"]);
  } catch {
    if (!dryRun) fail("Not signed in to npm. Run npm login, then npm run release again.");
  }
}
const canCreate = !ci && account === SCOPE_OWNER;
const tagsMoved = maintLine ? lineTag : `latest, ${lineTag}`;

console.log(
  `\n  Release from ${branch} ${read("git", ["rev-parse", "--short", "HEAD"])}, ` +
    `${ci ? "GitHub Actions (trusted publishing)" : `npm account ${account ?? "(none)"}`}:`,
);
for (const item of ordered) {
  const note = item.isNew ? (canCreate ? " (new package)" : ` (new package: needs the ${SCOPE_OWNER} account)`) : "";
  console.log(`    ${item.name}@${item.pkg.version}${note}`);
}
if (ordered.length) console.log(`  Tags moved: ${tagsMoved}.`);
for (const r of retag) console.log(`    ${r.id}: ${lineTag} catches up from ${r.from}`);
console.log("");
if (dryRun) process.exit(0);

// 2. Install, build and check what is about to ship.
if (ordered.length) {
  run("npm", ["ci", "--no-audit", "--no-fund"]);
  run("npm", ["run", "build"]);
  run(process.execPath, [
    "scripts/check-eve-line.mjs",
    ...ordered.map((item) => `packages/${item.dir}/package.json`),
  ]);
  if (ci) {
    // CI on the same push runs these too, but in parallel: a release must not
    // race ahead of a failing check.
    run("npm", ["run", "typecheck"]);
    run("npm", ["test"]);
    run(process.execPath, ["scripts/check-registry.mjs"]);
  }
}

// 3. Publish and tag. Nothing here waits on npm's CDN: a publish does not need its
// dependency's tarball to be downloadable, only an install does.
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
    // From a maint branch the line tag is the publish tag: `latest` belongs to master.
    run("npm", maintLine ? ["publish", "--tag", lineTag] : ["publish"], { cwd: `packages/${item.dir}` });
  } catch {
    fail(`${id} did not publish. Everything before it is out; ${again}.`);
  }
  if (!maintLine) {
    try {
      run("npm", ["dist-tag", "add", id, lineTag]);
    } catch {
      fail(`${id} is published but not tagged ${lineTag}. The next release run catches the tag up; ${again}.`);
    }
  }
  done.push({ id, name: item.name, version: item.pkg.version });
}

// 4. Line tags left behind an already published master version.
const caughtUp = [];
for (const r of retag) {
  try {
    run("npm", ["dist-tag", "add", r.id, lineTag]);
    caughtUp.push(r);
  } catch {
    fail(`Could not move ${lineTag} to ${r.id}; ${again}.`);
  }
}

// 5. Wait for the tarballs together, so consumers can install. Slow is a warning, not a failure.
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
for (const { id } of done) console.log(`    ${id} (${tagsMoved})`);
if (done.length === 0) console.log("    nothing");
for (const r of caughtUp) console.log(`    ${r.id}: ${lineTag} moved from ${r.from}`);
summary(
  [
    `### Released from \`${branch}\``,
    ...done.map(({ id }) => `- \`${id}\` (${tagsMoved})`),
    ...caughtUp.map((r) => `- \`${r.id}\`: ${lineTag} moved from ${r.from}`),
    done.length || caughtUp.length ? "" : "- nothing",
  ].join("\n"),
);
if (waiting.length > 0) {
  console.log("\n  Published, but npm is still slow to serve these (nothing to rerun; give it a few minutes before installing):");
  for (const { id } of waiting) console.log(`    ${id}`);
}
if (skipped.length > 0) {
  console.log("\n  Not released:");
  for (const s of skipped) {
    console.log(`    ${s.id}: ${s.why}`);
    if (ci) console.log(`::warning::${s.id} not released: ${s.why}`);
  }
  summary(["", "**Not released:**", ...skipped.map((s) => `- \`${s.id}\`: ${s.why}`)].join("\n"));
  console.log(`\n  To finish: npm login as ${SCOPE_OWNER}, then npm run release from ${branch}.`);
}
console.log("");
