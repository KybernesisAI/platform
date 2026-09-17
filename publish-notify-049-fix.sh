#!/usr/bin/env bash
# Republish the eve 0.49 notify build, COMPILED AGAINST EVE 0.49.
#
# 0.1.5 declared `peer eve >=0.49.0 <0.50.0` but was built with devDependency
# eve ^0.51.1, because the previous script moved the peer range and not the
# eve it builds against. eve 0.49 then could not bind the extension
# ("Selected module binding \"extensions/notify.ts\" has no compile or runtime
# usage"), and since the agent unit builds before every start, Kyber and Ava
# would not come up. Both are back on 0.1.3.
#
# 0.1.7 is the same source as 0.1.6, built on the 0.49 line. Do not reuse 0.1.5.
set -euo pipefail
cd "$(dirname "$0")/packages/notify"

VERSION=0.1.7
EVE_LINE="^0.49.0"
PEER=">=0.49.0 <0.50.0"

if npm view "@kybernesis/notify@$VERSION" version >/dev/null 2>&1; then
  echo "@kybernesis/notify@$VERSION already published — nothing to do."
  exit 0
fi

echo "==> pointing the package at eve $EVE_LINE (peer AND devDependency)"
node -e '
  const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8"));
  p.version=process.argv[1];
  p.peerDependencies.eve=process.argv[2];
  p.devDependencies.eve=process.argv[3];
  fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");
' "$VERSION" "$PEER" "$EVE_LINE"

echo "==> installing eve $EVE_LINE so the build compiles against the line it claims"
npm install --no-save "eve@$EVE_LINE"
echo "    building against eve $(node -p 'require("eve/package.json").version')"

echo "==> the invariant that would have caught 0.1.5"
node ../../scripts/check-eve-line.mjs package.json

npm run build
npm test
npm publish --access public

echo
echo "Published @kybernesis/notify@$VERSION (eve 0.49 line)."
echo "Then, on kyber and ava:"
echo "  npm install --save-exact @kybernesis/notify@$VERSION && sudo ./scripts/safe-restart.sh \$PWD <name>-agent"
