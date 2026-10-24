#!/usr/bin/env node
/**
 * Sign release/ as the Kybernesis publisher, so Buzz shows who published the
 * plugin and accepts updates only from the same key.
 *
 *   npm run sign                 # sign release/ (run after npm run build)
 *   npm run sign -- --create-key # once per publisher: make the key, keep it in the Keychain
 *
 * Buzz's own `buzzodz plugin sign` signs only with the Buzz identity saved for
 * the OS account, which is a person. The publisher here is the company, so the
 * key lives in the macOS Keychain under its own name and never leaves it. This
 * writes the same two files `buzzodz plugin sign` writes (NIP-PS, see buzz-app
 * docs/nips/NIP-PS.md): plugin.artifact.json, the exact bytes Buzz builds from
 * manifest.json, plugin.js, README.md and icon.png; and plugin.signature.json,
 * a kind 1064 event over their SHA-256. Buzz verifies both on install and on
 * every load.
 *
 * Losing the key means no more updates under this publisher: everyone would
 * remove the plugin and install it again. Keep a copy somewhere safe.
 * KYB_BUZZ_PUBLISHER_KEY (64 hex characters) overrides the Keychain, for tests.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";

const SERVICE = "ai.kybernesis.buzz-plugin-publisher";
const ACCOUNT = "kybernesis";
const release = fileURLToPath(new URL("../release/", import.meta.url));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const fail = (message) => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

function keychainKey() {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

if (process.argv.includes("--create-key")) {
  if (keychainKey()) fail(`The Keychain already holds a publisher key (${SERVICE}). Nothing changed.`);
  const secret = hex(schnorr.utils.randomSecretKey());
  // Through stdin, so the key never appears in a process listing.
  execFileSync("security", ["-i"], {
    input: `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -l "Kybernesis Buzz plugin publisher" -w ${secret}\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (keychainKey() !== secret) fail("The key did not reach the Keychain.");
  console.log(`\n  Publisher key saved in the Keychain as ${SERVICE}.`);
  console.log(`  Publisher: ${hex(schnorr.getPublicKey(Buffer.from(secret, "hex")))}\n`);
  process.exit(0);
}

const secretHex = process.env.KYB_BUZZ_PUBLISHER_KEY ?? keychainKey();
if (!secretHex || !/^[0-9a-f]{64}$/.test(secretHex)) {
  fail(`No publisher key. Run npm run sign -- --create-key once on the publishing Mac.`);
}
const secret = Buffer.from(secretHex, "hex");
const publisher = hex(schnorr.getPublicKey(secret));

// The artifact, byte for byte as buzz-app's artifact_from_parts writes it:
// compact JSON, the manifest's fields in its struct order, icons as base64.
const read = (name) => readFileSync(`${release}${name}`);
const optional = (name) => (existsSync(`${release}${name}`) ? read(name) : undefined);
const source = JSON.parse(read("manifest.json").toString("utf8"));
const manifest = {};
for (const key of ["id", "name", "apiVersion", "description", "discovery", "host"]) {
  if (source[key] !== undefined) manifest[key] = source[key];
}
const unknown = Object.keys(source).filter((key) => !(key in manifest));
if (unknown.length) fail(`manifest.json has fields Buzz does not accept: ${unknown.join(", ")}`);
const artifact = { manifest, code: read("plugin.js").toString("utf8") };
const readme = optional("README.md");
if (readme) artifact.readme = readme.toString("utf8");
const iconPng = optional("icon.png");
if (iconPng) artifact.iconPng = iconPng.toString("base64");
const iconJpg = optional("icon.jpg");
if (iconJpg) artifact.iconJpg = iconJpg.toString("base64");
const bytes = Buffer.from(JSON.stringify(artifact), "utf8");

// NIP-01 event: id is the SHA-256 of the serialized fields, sig a BIP-340
// Schnorr signature over the id.
const created_at = Math.floor(Date.now() / 1000);
const kind = 1064;
const tags = [
  ["x", sha256(bytes)],
  ["t", "buzz-plugin-release-v1"],
];
const content = "";
const id = sha256(JSON.stringify([0, publisher, created_at, kind, tags, content]));
const sig = hex(schnorr.sign(Buffer.from(id, "hex"), secret));
if (!schnorr.verify(Buffer.from(sig, "hex"), Buffer.from(id, "hex"), Buffer.from(publisher, "hex"))) {
  fail("The signature did not verify; nothing was written.");
}

writeFileSync(`${release}plugin.artifact.json`, bytes);
writeFileSync(
  `${release}plugin.signature.json`,
  `${JSON.stringify({ id, pubkey: publisher, created_at, kind, tags, content, sig }, null, 2)}\n`,
);
console.log(`\n  Signed release/ as ${publisher}. Commit plugin.artifact.json and plugin.signature.json.\n`);
