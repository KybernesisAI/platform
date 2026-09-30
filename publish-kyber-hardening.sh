#!/usr/bin/env bash
#
# Publish the client-hardening work, in order.
#
# Five publishes, because three of these packages ship ONE BUILD PER EVE LINE
# and the fleet straddles two: Kyber and Ava run eve 0.49, Sid runs 0.51. The
# same code has to go out twice, under two version numbers, with two different
# declared peer ranges. Getting that wrong is the defect this very work fixes,
# so the script sets the range itself rather than trusting anyone to remember.
#
# Safe to re-run: a version already on npm is skipped, not retried.
set -euo pipefail
cd "$(dirname "$0")"

pub() { # pkg version evepeer devpeer
  local pkg=$1 version=$2 peer=$3 dev=$4 dir="packages/$1"
  if npm view "@kybernesis/$pkg@$version" version >/dev/null 2>&1; then
    echo "✓ @kybernesis/$pkg@$version already published — skipping"
    return 0
  fi
  echo
  echo "── @kybernesis/$pkg@$version   (eve ${peer:-none}) ──────────────────"
  ( cd "$dir"
    python3 - "$version" "$peer" "$dev" <<'PY'
import json, re, sys
version, peer, dev = sys.argv[1], sys.argv[2], sys.argv[3]
s = open("package.json").read()
s = re.sub(r'"version": "[^"]+"', f'"version": "{version}"', s, count=1)
if peer:
    s = re.sub(r'("peerDependencies":\s*\{[^}]*?"eve":\s*)"[^"]+"', r'\1"' + peer + '"', s, flags=re.S)
if dev:
    s = re.sub(r'("devDependencies":\s*\{[^}]*?"eve":\s*)"[^"]+"', r'\1"' + dev + '"', s, flags=re.S)
open("package.json", "w").write(s)
PY
    npm install --no-audit --no-fund >/dev/null 2>&1 || true
    echo "  building against eve $(node -p "require('eve/package.json').version" 2>/dev/null || echo '?')"
    npm run build >/dev/null
    npm test >/dev/null 2>&1 || { echo "  ✗ tests failed — NOT publishing"; exit 1; }
    npm publish
  )
  echo "✓ @kybernesis/$pkg@$version published"
}

# One build, no eve peer: the CLI is line-agnostic.
pub create 0.15.7 "" ""

# eve 0.49 line — Kyber and Ava.
pub notify 0.1.3  ">=0.49.0 <0.50.0" "^0.49.0"
pub exe    0.12.6 ">=0.49.0 <0.50.0" "^0.49.0"

# eve 0.51 line — Sid.
pub notify 0.1.4  ">=0.51.0 <0.52.0" "^0.51.1"
pub exe    0.12.7 ">=0.51.0 <0.52.0" "^0.51.1"

echo
echo "All five published. Leaving the working tree on the 0.51 builds;"
echo "git checkout -- packages/*/package.json to restore."
