#!/usr/bin/env node
/**
 * Give packages the same npm trusted publisher as a reference package, so
 * .github/workflows/publish.yml can publish them.
 *
 *   cd ~/platform && node scripts/trust-publisher.mjs                 # every public package
 *   cd ~/platform && node scripts/trust-publisher.mjs @kybernesis/foo # just these
 *   options: --like <pkg> (reference, default @kybernesis/arcana)
 *            --skip <pkg> (repeatable)
 *
 * Set the reference up once on npmjs.com (package → Settings → Trusted
 * Publisher → GitHub Actions: KybernesisAI / platform / publish.yml /
 * environment npm, allow npm publish AND allow npm dist-tag). This copies its
 * permissions, because `npm trust github` has no flag for the dist-tag one.
 *
 * It runs npm's own `npm trust github` (npm 11.21, installed into a temp dir),
 * so signing in and two-factor are npm's usual browser prompts: approve the
 * first one and tick "skip for 5 minutes" so the rest go straight through.
 * A package that already has a trusted publisher is skipped, never replaced.
 * npm drops a new trusted publisher that no publish uses within 2 days, so
 * only connect packages that are about to publish.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "KybernesisAI/platform";
const WORKFLOW = "publish.yml";
const ENVIRONMENT = "npm";
const NPM = "npm@11.21.2";

const args = process.argv.slice(2);
const take = (flag) => {
  const out = [];
  for (let i = args.indexOf(flag); i !== -1; i = args.indexOf(flag)) out.push(...args.splice(i, 2).slice(1));
  return out;
};
const like = take("--like")[0] ?? "@kybernesis/arcana";
const skip = new Set(take("--skip"));
let targets = args;
if (targets.length === 0) {
  if (!existsSync("packages")) {
    console.error("Run this from the platform checkout (cd ~/platform), or name the packages.");
    process.exit(2);
  }
  targets = readdirSync("packages")
    .map((dir) => join("packages", dir, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")))
    .filter((pkg) => !pkg.private)
    .map((pkg) => pkg.name);
}
targets = targets.filter((name) => name !== like && !skip.has(name));

const dir = mkdtempSync(join(tmpdir(), "kyb-trust-"));
console.log(`\n  Fetching ${NPM} (its trust command) into ${dir}…`);
const install = spawnSync("npm", ["install", "--prefix", dir, NPM, "--registry=https://registry.npmjs.org/", "--no-audit", "--no-fund", "--loglevel=error"], {
  stdio: "inherit",
});
if (install.status !== 0) process.exit(install.status ?? 1);
const npmDir = join(dir, "node_modules", "npm");

// One npm command per process, with two hooks into npm's trust command: the
// listing is written to a file (so npm's own prompts stay on screen), and a new
// connection carries the reference's permissions.
const child = join(dir, "trust-child.cjs");
writeFileSync(
  child,
  `const path = require("node:path");
const fs = require("node:fs");
const npmDir = process.env.KYB_NPM_DIR;
const TrustCommand = require(path.join(npmDir, "lib/trust-cmd.js"));
if (process.env.KYB_TRUST_OUT) {
  TrustCommand.prototype.displayResponseBody = function ({ body }) {
    fs.writeFileSync(process.env.KYB_TRUST_OUT, JSON.stringify(body ?? []));
  };
}
if (process.env.KYB_TRUST_PERMS) {
  const perms = JSON.parse(process.env.KYB_TRUST_PERMS);
  const create = TrustCommand.prototype.createConfig;
  TrustCommand.prototype.createConfig = function (name, body) {
    body[0].permissions = perms;
    return create.call(this, name, body);
  };
}
process.argv = [process.argv[0], path.join(npmDir, "bin/npm-cli.js"), ...JSON.parse(process.env.KYB_NPM_ARGS)];
require(path.join(npmDir, "lib/cli.js"))(process);
`,
);

const npm = (npmArgs, env = {}) =>
  spawnSync(process.execPath, [child], {
    stdio: "inherit",
    env: { ...process.env, KYB_NPM_DIR: npmDir, KYB_NPM_ARGS: JSON.stringify(npmArgs), ...env },
  }).status;

const configsOf = (name) => {
  const out = join(dir, `list-${name.replace(/[^a-z0-9]+/gi, "_")}.json`);
  if (npm(["trust", "list", name], { KYB_TRUST_OUT: out }) !== 0 || !existsSync(out)) return null;
  return JSON.parse(readFileSync(out, "utf8"));
};

console.log(`\n  Reading ${like}'s trusted publisher…`);
const reference = (configsOf(like) ?? []).find(
  (c) => c.type === "github" && c.claims?.repository === REPO && c.claims?.workflow_ref?.file === WORKFLOW,
);
if (!reference) {
  console.error(`\n  ${like} has no GitHub Actions trusted publisher for ${REPO} ${WORKFLOW}. Set it up on npmjs.com first.\n`);
  process.exit(1);
}
const perms = reference.permissions ?? [];
if (reference.claims?.environment !== ENVIRONMENT || perms.length < 2) {
  console.error(
    `\n  ${like}'s trusted publisher has environment "${reference.claims?.environment ?? ""}" and permissions ` +
      `${JSON.stringify(perms)}. It needs environment "${ENVIRONMENT}" and both allow npm publish and allow npm dist-tag.\n`,
  );
  process.exit(1);
}
console.log(`  Permissions to copy: ${JSON.stringify(perms)}`);

const results = [];
for (const name of targets) {
  console.log(`\n  ${name}`);
  const existing = configsOf(name);
  if (existing === null) {
    results.push([name, "could not read its trusted publishers"]);
    continue;
  }
  if (existing.length > 0) {
    results.push([name, "already connected, left alone"]);
    continue;
  }
  const status = npm(
    ["trust", "github", name, "--file", WORKFLOW, "--repo", REPO, "--env", ENVIRONMENT, "--allow-publish", "--yes"],
    { KYB_TRUST_PERMS: JSON.stringify(perms) },
  );
  results.push([name, status === 0 ? "connected" : "FAILED (see above)"]);
}

console.log("\n  Done:");
for (const [name, what] of results) console.log(`    ${name}: ${what}`);
console.log("");
process.exit(results.some(([, what]) => what.startsWith("FAILED") || what.startsWith("could not")) ? 1 : 0);
