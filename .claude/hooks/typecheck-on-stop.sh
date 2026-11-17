#!/usr/bin/env bash
# Stop hook: before Claude ends its turn with TypeScript changes in this checkout, typecheck
# only the packages that changed and hand any errors back so they get fixed first.
# Skips when nothing .ts changed, when dependencies aren't installed, and on the second stop
# in a row (stop_hook_active), so it can never loop.
input=$(cat)
[ "$(jq -r '.stop_hook_active // false' <<<"$input" 2>/dev/null)" = true ] && exit 0
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 0
[ -d node_modules ] || exit 0
pkgs=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } \
  | grep -E '^(packages|fixtures)/[^/]+/.*\.(ts|tsx|mts)$' | cut -d/ -f1-2 | sort -u )
[ -n "$pkgs" ] || exit 0
fail=""
for p in $pkgs; do
  [ -f "$p/package.json" ] || continue
  out=$(cd "$p" && timeout 120 npm run --silent typecheck --if-present 2>&1) || fail+="== $p"$'\n'"$(tail -n 20 <<<"$out")"$'\n'
done
[ -z "$fail" ] && exit 0
echo "Typecheck fails on your uncommitted changes; fix it before you finish:" >&2
echo "$fail" >&2
exit 2
