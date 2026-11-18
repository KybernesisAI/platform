#!/usr/bin/env bash
# Stop hook: before Claude ends its turn with TypeScript changes in this checkout, typecheck
# only the packages that changed and hand any errors back so they get fixed first.
# Skips when nothing .ts changed, when dependencies aren't installed, and on the second stop
# in a row (stop_hook_active), so it can never loop.
input=$(cat)
# No jq needed: a missing jq must never turn the second stop into a third.
[[ $input =~ \"stop_hook_active\"[[:space:]]*:[[:space:]]*true ]] && exit 0
# timeout isn't on stock macOS: use it (or gtimeout) when present, else run the check directly.
to() { local s=$1; shift; if command -v timeout >/dev/null; then timeout "$s" "$@"; elif command -v gtimeout >/dev/null; then gtimeout "$s" "$@"; else "$@"; fi; }
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 0
[ -d node_modules ] || exit 0
pkgs=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } \
  | grep -E '^(packages|fixtures)/[^/]+/.*\.(ts|tsx|mts)$' | cut -d/ -f1-2 | sort -u )
[ -n "$pkgs" ] || exit 0
fail=""
for p in $pkgs; do
  [ -f "$p/package.json" ] || continue
  out=$(cd "$p" && to 120 npm run --silent typecheck --if-present 2>&1); rc=$?
  # 124 timed out, 126/127 tool missing: not a type error, so don't hold the stop.
  case $rc in 0|124|126|127) ;; *) fail+="== $p"$'\n'"$(tail -n 20 <<<"$out")"$'\n' ;; esac
done
[ -z "$fail" ] && exit 0
echo "Typecheck fails on your uncommitted changes; fix it before you finish:" >&2
echo "$fail" >&2
exit 2
