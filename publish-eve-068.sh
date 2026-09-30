#!/usr/bin/env bash
# Publish the eve 0.68 line of every @kybernesis package, dependencies first.
# Human-run: npm asks for the browser 2FA on each publish. DRY_RUN=1 to rehearse.
set -euo pipefail
cd "$(dirname "$0")"
ORDER=(identity exe enterprise arcana evals dispatch connectors local manage notify voice multiplayer engineer buzz create)
node scripts/check-eve-line.mjs
for p in "${ORDER[@]}"; do
  v=$(node -p "require('./packages/$p/package.json').version")
  echo "== @kybernesis/$p@$v"
  if [ "${DRY_RUN:-}" = "1" ]; then
    npm publish -w "@kybernesis/$p" --access public --dry-run 2>&1 | grep -E "npm notice (name|version|package size)|error" || true
  else
    npm publish -w "@kybernesis/$p" --access public
  fi
done
echo "all ${#ORDER[@]} published"
