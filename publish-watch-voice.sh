#!/usr/bin/env bash
# Publishes the watch-voice work: enterprise, notify and voice, ONE BUILD PER EVE
# LINE, each compiled against the eve it declares and checked before it goes.
# Re-runnable: anything already on npm is skipped, so a 2FA timeout mid-way is
# recovered by running it again. DRY_RUN=1 does everything but publish.
set -euo pipefail
cd "$(dirname "$0")"

on_npm() { npm view "$1@$2" version >/dev/null 2>&1; }

publish() { # <dir> <name> <version> <eve peer range> <eve devDep>
  local dir=$1 name=$2 version=$3 peer=$4 dev=$5
  if on_npm "$name" "$version"; then echo "→ $name@$version already published, skipping"; return 0; fi
  echo "=== $name@$version  (eve $peer) ==="
  ( cd "$dir"
    node -e '
      const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8"));
      p.version=process.argv[1]; p.peerDependencies.eve=process.argv[2]; p.devDependencies.eve=process.argv[3];
      fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");
    ' "$version" "$peer" "$dev"
    npm install --no-save "eve@$dev" >/dev/null 2>&1
    echo "    building against eve $(node -p 'require(require.resolve("eve/package.json",{paths:[process.cwd()]})).version')"
    npm run build
    npm test
    node ../../scripts/check-eve-line.mjs package.json
    if [ -n "${DRY_RUN:-}" ]; then echo "    (dry run — not published)"; else npm publish --access public; fi
  )
}

L49=">=0.49.0 <0.50.0"; D49="^0.49.0"     # Kyber, Ava
L51=">=0.51.0 <0.52.0"; D51="^0.51.1"     # Sid, Foreman

publish packages/enterprise @kybernesis/enterprise 0.8.3 "$L51" "$D51"
publish packages/enterprise @kybernesis/enterprise 0.8.4 "$L49" "$D49"
publish packages/notify     @kybernesis/notify     0.1.8 "$L51" "$D51"
publish packages/notify     @kybernesis/notify     0.1.9 "$L49" "$D49"
publish packages/voice      @kybernesis/voice      0.1.4 "$L51" "$D51"
publish packages/voice      @kybernesis/voice      0.1.3 "$L49" "$D49"

echo; echo "All six published."
