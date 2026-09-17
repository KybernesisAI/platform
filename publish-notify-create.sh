#!/usr/bin/env bash
# Ordered, re-runnable. Skips any version already on npm, so a 2FA timeout
# mid-way is recovered by simply running it again.
set -euo pipefail
cd "$(dirname "$0")"

on_npm() { npm view "$1@$2" version >/dev/null 2>&1; }

publish() { # <dir> <name> <version> <eve peer range>
  local dir=$1 name=$2 version=$3 peer=$4
  if on_npm "$name" "$version"; then
    echo "→ $name@$version already published, skipping"
    return 0
  fi
  echo "=== $name@$version  (eve $peer) ==="
  ( cd "$dir"
    node -e '
      const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8"));
      p.version=process.argv[1];
      p.peerDependencies=p.peerDependencies||{};
      if (process.argv[2] !== "-") p.peerDependencies.eve=process.argv[2];
      fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");
    ' "$version" "$peer"
    # A per-line build must be COMPILED against the line it declares. Moving
    # the peer range alone shipped notify 0.1.5 as a 0.51 build wearing a 0.49
    # label, and eve 0.49 could not bind its extension — two agents would not
    # start. Install the matching eve first, then refuse to publish a mismatch.
    if [ "$peer" != "-" ]; then
      eve_line="^$(printf '%s' "$peer" | sed -E 's/^>=([0-9]+\.[0-9]+)\..*/\1.0/')"
      node -e '
        const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8"));
        p.devDependencies=p.devDependencies||{}; p.devDependencies.eve=process.argv[1];
        fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");
      ' "$eve_line"
      npm install --no-save "eve@$eve_line"
      node ../../scripts/check-eve-line.mjs package.json
    fi
    npm run build
    node --test test/*.test.mjs
    npm publish --access public
  )
}

# ── @kybernesis/notify ────────────────────────────────────────────────────
# askingUser is default-deny: a person is principalType "user", and nothing
# else is. The previous guard listed the machine types, so eve's own
# `local-dev` principal — on EVERY eve dev turn and every eval turn — was
# treated as a person and POSTed to the control plane for a 500 each time.
# One build per eve line; the fix has to reach both live lines.
publish packages/notify @kybernesis/notify 0.1.5 ">=0.49.0 <0.50.0"   # Kyber, Ava
publish packages/notify @kybernesis/notify 0.1.6 ">=0.51.0 <0.52.0"   # Sid, Foreman

# ── @kybernesis/create ────────────────────────────────────────────────────
# doctor now reads the URL-shaped settings at rest. A scheme-less POSTHOG_HOST
# never fails at start; it fails inside the drain once per turn, forever, and
# dropped every analytics event on the reference fleet while reporting healthy.
# No eve peer: the CLI is a single line.
publish packages/create @kybernesis/create 0.15.8 "-"

echo
echo "All published."
