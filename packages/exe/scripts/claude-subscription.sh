#!/usr/bin/env bash
#
# Put an agent on a Claude subscription — no API key, on any host.
#
# Ships with @kybernesis/exe. Run it on the VM the agent runs on:
#
#   bash scripts/claude-subscription.sh up      # start the proxy
#   bash scripts/claude-subscription.sh login   # sign in the subscription
#   bash scripts/claude-subscription.sh status  # is it alive, is it exposed
#
# Then point the agent at it with claudeSubscription() from @kybernesis/exe.
#
# WHY A PROXY AT ALL, when the exe LLM integration already serves Claude ids:
# that integration reaches Anthropic through a gateway, which bills metered API
# usage. A subscription authenticates with an OAuth bearer that Anthropic's
# billing validator accepts INSTEAD of a key, and that bearer expires and must
# be refreshed. Something has to own that refresh. Here it is a small proxy
# holding Claude Code's own credentials, so the agent process never holds a
# long-lived secret and speaks ordinary Anthropic API to loopback.
#
# THE COST OF THAT SHAPE, worth knowing before you promise it to a client:
# Grok and ChatGPT subscriptions are a FILE somebody keeps fresh. This one is a
# PROCESS to keep alive. When it stops, every turn fails with a connection error
# thrown from inside the model SDK, which reads like the model being down — and
# people go and look at Anthropic's status page rather than at a container that
# exited overnight. That is why this runs under --restart unless-stopped, and
# why hostPreflight({ claudeProxyUrl }) asks about it at boot.
set -euo pipefail

AGENT="${AGENT_NAME:-$(basename "$PWD")}"
NAME="${CLAUDE_PROXY_NAME:-${AGENT}-claude-subscription}"
VOLUME="${CLAUDE_PROXY_VOLUME:-${NAME}-data}"
PORT="${CLAUDE_PROXY_PORT:-3333}"

# Upstream publishes a multi-arch image that bundles the `claude` CLI, so
# onboarding happens inside the container and nobody clones anything.
#
# It has one defect for our agents. The proxy obfuscates tool names — sensible
# for tools an agent defines, wrong for Anthropic's PROVIDER-DEFINED tools,
# which are validated by name upstream. With the stock image, an agent that can
# search the web fails every such turn with:
#
#   tools.N.web_search_20250305.name: Input should be 'web_search'
#
# an error naming a tool index and a schema, which reads like a bug in the
# agent's own tool definitions and says nothing about a rewrite in the middle.
# Our fix is carried in patches/ and is NOT upstream (last change to the file
# it patches was April). Set CLAUDE_PROXY_IMAGE to a patched build for any
# agent that uses web search; leave it alone for agents that do not.
# Pinned to the revision our patch targets, never a floating tag. Upstream
# publishes `main` and per-commit `sha-*` tags; `main` moving under a fleet of
# client hosts is a fleet that changes behaviour on a restart nobody ordered.
PATCHED_TAG="${CLAUDE_PROXY_PATCHED_TAG:-claude-auth-proxy:a62318f-provider-tools}"
STOCK_IMAGE="ghcr.io/ansg191/claude-auth-proxy:sha-a62318f"

# Prefer a patched image that has already been built on this host. Whether an
# agent needs one is NOT something you can tell by reading its source: the
# provider-defined tools come from extensions, so an agent with no mention of
# web_search anywhere in its own code still sends one. That was learned by
# putting a real agent on the stock image and watching every turn fail.
pick_image() {
  if [ -n "${CLAUDE_PROXY_IMAGE:-}" ]; then echo "$CLAUDE_PROXY_IMAGE"; return; fi
  if docker image inspect "$PATCHED_TAG" >/dev/null 2>&1; then echo "$PATCHED_TAG"; return; fi
  echo "$STOCK_IMAGE"
}

die() { echo "  ✗ $*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed on this host."
}

# Whether a sign-in exists in the volume, regardless of whether the running
# process has read it. Needs root to read a docker volume, so it answers
# "unknown" rather than "no" when it cannot look — a guess here would send
# somebody back through a browser flow they already completed.
credentials_on_disk() {
  local mount
  mount=$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null) || return 2
  sudo -n test -f "${mount}/.claude/.credentials.json" 2>/dev/null && return 0
  sudo -n true 2>/dev/null && return 1
  return 2
}

ready_state() {
  # /ready is 200 only once a credential is loaded; /health answers as soon as
  # the process is listening. The difference is exactly "running" vs "signed
  # in", and conflating them is how a proxy looks fine and answers nothing.
  curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PORT}/ready" 2>/dev/null || echo 000
}

# THE THIRD STATE, and the one that cost a morning: signed in with a DEAD
# credential. /ready reports that a credential was LOADED, not that it is still
# worth anything. When the refresh token reaches its own expiry the proxy
# writes the file back with EMPTY token strings and goes on serving /ready 200
# — so `status` said "signed in, answering" while every single turn 401'd with
# "OAuth access token has expired". Only the upstream API can answer this
# honestly, so ask it rather than trusting a liveness endpoint.
auth_state() {
  curl -s -o /dev/null -w '%{http_code}' -m 10 \
    -H 'anthropic-version: 2023-06-01' \
    "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null || echo 000
}

# Whole days until the REFRESH token expires; empty when it cannot be read.
#
# The access token refreshing cleanly tells you nothing. It did exactly that,
# every hour, for four weeks — while the refresh token underneath it aged out
# on a fixed ~28-day window. That is the expiry that ends the sign-in, using it
# does not extend it, and nothing in place recovers once it passes. So it is
# the number to put in front of somebody BEFORE it lands, not after.
refresh_days_left() {
  local mount
  mount=$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null) || return 1
  sudo -n python3 -c '
import json, sys, time
try:
    d = json.load(open(sys.argv[1]))["claudeAiOauth"]
except Exception:
    sys.exit(1)
exp = d.get("refreshTokenExpiresAt") or 0
if not exp or not d.get("refreshToken"):
    sys.exit(1)
print(int((exp / 1000 - time.time()) // 86400))
' "${mount}/.claude/.credentials.json" 2>/dev/null || return 1
}

case "${1:-}" in
  up)
    require_docker
    docker volume create "$VOLUME" >/dev/null
    if [ -n "$(docker ps -aq -f "name=^${NAME}$")" ]; then
      docker start "$NAME" >/dev/null
      echo "  ✓ ${NAME} started (existing container, credentials preserved)"
    else
      # Bound to 127.0.0.1 deliberately and not configurably. This endpoint
      # spends a paid subscription and asks for no credential of its own, so a
      # published port is an open gateway to someone's Claude account for
      # anyone who finds it. claudeSubscription() refuses a non-loopback URL
      # for the same reason.
      IMAGE="$(pick_image)"
      # Anthropic gates new models on the Claude Code version a client presents
      # (Opus 5.5 needs >=2.1.280). The image bakes in the version of the CLI it
      # downloaded at build time, so an older image is refused for a newer model
      # with "Claude Code X does not support this model". CLAUDE_PROXY_CLI_VERSION
      # overrides what the proxy presents without rebuilding the image.
      docker run -d \
        --name "$NAME" \
        --restart unless-stopped \
        -v "${VOLUME}:/home/nonroot" \
        -p "127.0.0.1:${PORT}:3000" \
        ${CLAUDE_PROXY_CLI_VERSION:+-e "ANTHROPIC_CLI_VERSION=${CLAUDE_PROXY_CLI_VERSION}"} \
        "$IMAGE" >/dev/null
      echo "  ✓ ${NAME} created from ${IMAGE}"
      if [ "$IMAGE" = "$STOCK_IMAGE" ]; then
        echo "  ! stock image: provider-defined tool names are rewritten. If this agent has"
        echo "    web search — including from an extension, which its own source will not"
        echo "    show — every such turn fails with 'Input should be web_search'."
        echo "    Fix ahead of time:  bash scripts/claude-subscription.sh build-patched"
      fi
    fi
    sleep 2
    if [ "$(ready_state)" = "200" ]; then
      echo "  ✓ signed in and ready on http://127.0.0.1:${PORT}"
    else
      echo "  ! running, but no subscription credential yet."
      echo "    Next: bash scripts/claude-subscription.sh login"
    fi
    ;;

  login)
    require_docker
    [ -n "$(docker ps -q -f "name=^${NAME}$")" ] || die "${NAME} is not running. Run 'up' first."
    echo "  Choose 'Sign in with Claude' — the OAuth option, NOT an API key."
    echo "  An API key here bills metered usage and defeats the whole point."
    echo
    docker exec -it "$NAME" claude
    echo
    # Credentials are read at startup, so a sign-in during a run does not take
    # effect until the process reloads them.
    docker restart "$NAME" >/dev/null
    sleep 3
    # Confirm against the API, not /ready: a blanked credential loads happily.
    if [ "$(auth_state)" = "200" ]; then
      echo "  ✓ subscription live — http://127.0.0.1:${PORT}"
      days=$(refresh_days_left) && echo "  ✓ good for ${days}d — next login due $(date -d "+${days} days" +%d\ %b 2>/dev/null || date -v"+${days}d" +%d\ %b 2>/dev/null)"
    else
      echo "  ✗ still not authenticating (/v1/models → $(auth_state))."
      echo "    Re-run login and choose 'Sign in with Claude', completing the browser step."
    fi
    ;;

  reload)
    # The proxy reads credentials ONCE, at startup. Sign in while it is running
    # — through this script's `login`, or by hand with `docker exec` — and it
    # keeps serving 503 with a perfectly good credential sitting in its volume,
    # while `status` tells you to go and sign in again. That happened on the
    # first real deployment and sent someone back through the browser flow they
    # had just completed.
    require_docker
    docker restart "$NAME" >/dev/null
    sleep 4
    if [ "$(auth_state)" = "200" ]; then
      echo "  ✓ ${NAME}: credentials reloaded and authenticating on 127.0.0.1:${PORT}"
    elif [ "$(ready_state)" = "200" ]; then
      echo "  ✗ ${NAME}: reloaded a credential that no longer authenticates. Reloading"
      echo "    cannot fix an expired sign-in — run 'login'."
    else
      echo "  ✗ still not ready. Run 'login' — there may be no sign-in in ${VOLUME} yet."
    fi
    ;;

  status)
    require_docker
    state=$(ready_state)
    running=$(docker ps -q -f "name=^${NAME}$")
    [ -n "$running" ] || die "${NAME} is not running. Every turn will fail looking like a model outage."
    if [ "$state" = "200" ]; then
      # Loaded is not the same as valid. Ask the API before claiming health.
      auth=$(auth_state)
      case "$auth" in
        200)
          echo "  ✓ ${NAME}: signed in and authenticating, answering on 127.0.0.1:${PORT}"
          ;;
        401|403)
          echo "  ✗ ${NAME}: credential is DEAD (/ready → 200 but /v1/models → ${auth})."
          echo "    The refresh token expired and the proxy blanked the sign-in. Nothing"
          echo "    in place recovers from this. Run 'login'."
          ;;
        *)
          echo "  ! ${NAME}: loaded a credential, but the API is unreachable (/v1/models → ${auth})."
          echo "    Check the host's network before assuming a sign-in problem."
          ;;
      esac
    else
      credential_rc=0
      credentials_on_disk || credential_rc=$?
      case $credential_rc in
        0) echo "  ! ${NAME}: signed in, but this process has not loaded it (/ready → ${state}). Run 'reload'." ;;
        1) echo "  ✗ ${NAME}: running but NOT signed in (/ready → ${state}). Run 'login'." ;;
        *) echo "  ✗ ${NAME}: not ready (/ready → ${state}). Run 'reload' first; if that does not fix it, 'login'." ;;
      esac
    fi
    # The sign-in dies on a schedule, so say when — an outage you can diary is
    # not an outage. Silent when it cannot read the volume: a missing number is
    # not a reason to nag, and root is not always available here.
    if days=$(refresh_days_left); then
      if   [ "$days" -lt 0 ]; then echo "  ✗ sign-in EXPIRED $(( -days ))d ago — run 'login'."
      elif [ "$days" -le 3 ]; then echo "  ✗ sign-in expires in ${days}d — run 'login' now, before it strands the agent."
      elif [ "$days" -le 7 ]; then echo "  ! sign-in expires in ${days}d — book the re-login."
      else echo "  ✓ sign-in valid for ${days}d"
      fi
    fi
    # A port published on 0.0.0.0 is the failure that costs money rather than
    # uptime, so it is checked here and not left to a code review.
    docker port "$NAME" 3000 | grep -q '^127\.0\.0\.1:' \
      && echo "  ✓ loopback only" \
      || echo "  ✗ EXPOSED off-host — this port spends a paid subscription. Recreate with 'down' then 'up'."
    ;;

  build-patched)
    # For agents that use web search. Upstream has not taken our fix (the file
    # it patches last changed in April), so the published image still renames
    # provider-defined tools and every such turn fails with an error that names
    # a tool index and a schema — nothing that points at a proxy in the middle.
    #
    # Done here, by the script, from a pinned revision with the patch that
    # ships in this package. Nobody types a git URL, and the patch cannot be
    # lost in a rebuild the way it was when it lived only inside an image tag.
    require_docker
    command -v git >/dev/null 2>&1 || die "git is not installed on this host."
    REV="a62318f9"
    TAG="${CLAUDE_PROXY_PATCHED_TAG:-claude-auth-proxy:${REV:0:7}-provider-tools}"
    # Looked for in both places this script legitimately runs from: inside the
    # installed package, and copied into an agent's own scripts/ — which is
    # where `kyb init` puts it, so resolving only relative to the script found
    # nothing in the common case.
    HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PATCH=""
    for candidate in \
      "${HERE}/../patches/claude-auth-proxy-provider-tools.patch" \
      "${HERE}/../node_modules/@kybernesis/exe/patches/claude-auth-proxy-provider-tools.patch" \
      "${PWD}/node_modules/@kybernesis/exe/patches/claude-auth-proxy-provider-tools.patch"; do
      [ -f "$candidate" ] && { PATCH="$candidate"; break; }
    done
    [ -n "$PATCH" ] || die "patch not found. Install @kybernesis/exe, or run this from the agent directory."

    SRC="${CLAUDE_PROXY_SRC:-${HOME}/.cache/kybernesis/claude-auth-proxy}"
    mkdir -p "$(dirname "$SRC")"
    [ -d "$SRC/.git" ] || git clone -q https://github.com/ansg191/claude-auth-proxy.git "$SRC"
    git -C "$SRC" fetch -q --all
    git -C "$SRC" checkout -q "$REV"
    git -C "$SRC" checkout -q -- .
    git -C "$SRC" apply "$PATCH" || die "patch did not apply at ${REV} — do not ship an unpatched image for an agent that searches the web."
    docker build -q -t "$TAG" "$SRC" >/dev/null
    git -C "$SRC" checkout -q -- .
    echo "  ✓ built ${TAG} (patched: provider-defined tool names preserved)"
    echo "    Use it:  CLAUDE_PROXY_IMAGE=${TAG} bash scripts/claude-subscription.sh up"
    ;;

  recreate)
    # Same image, same credential volume, fresh container — for a changed
    # CLAUDE_PROXY_CLI_VERSION (or port). The sign-in lives in the volume, so
    # no browser is needed afterwards.
    require_docker
    if [ -n "$(docker ps -aq -f "name=^${NAME}$")" ]; then
      IMAGE="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
      docker rm -f "$NAME" >/dev/null
      echo "  ✓ removed ${NAME} (credentials kept in ${VOLUME})"
      CLAUDE_PROXY_IMAGE="${CLAUDE_PROXY_IMAGE:-$IMAGE}" "$0" up
    else
      "$0" up
    fi
    ;;

  down)
    require_docker
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "  ✓ ${NAME} removed. The volume ${VOLUME} keeps the sign-in for next time."
    ;;

  *)
    echo "usage: bash scripts/claude-subscription.sh {up|login|reload|status|down|build-patched}"
    exit 1
    ;;
esac
