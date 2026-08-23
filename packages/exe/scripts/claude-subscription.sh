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
IMAGE="${CLAUDE_PROXY_IMAGE:-ghcr.io/ansg191/claude-auth-proxy:sha-a62318f}"

die() { echo "  ✗ $*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed on this host."
}

ready_state() {
  # /ready is 200 only once a credential is loaded; /health answers as soon as
  # the process is listening. The difference is exactly "running" vs "signed
  # in", and conflating them is how a proxy looks fine and answers nothing.
  curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PORT}/ready" 2>/dev/null || echo 000
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
      docker run -d \
        --name "$NAME" \
        --restart unless-stopped \
        -v "${VOLUME}:/home/nonroot" \
        -p "127.0.0.1:${PORT}:3000" \
        "$IMAGE" >/dev/null
      echo "  ✓ ${NAME} created from ${IMAGE}"
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
    [ "$(ready_state)" = "200" ] \
      && echo "  ✓ subscription loaded — http://127.0.0.1:${PORT}" \
      || echo "  ✗ still no credential. Re-run login and complete the browser step."
    ;;

  status)
    require_docker
    state=$(ready_state)
    running=$(docker ps -q -f "name=^${NAME}$")
    [ -n "$running" ] || die "${NAME} is not running. Every turn will fail looking like a model outage."
    [ "$state" = "200" ] \
      && echo "  ✓ ${NAME}: signed in, answering on 127.0.0.1:${PORT}" \
      || echo "  ✗ ${NAME}: running but NOT signed in (/ready → ${state}). Run 'login'."
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
    PATCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/patches/claude-auth-proxy-provider-tools.patch"
    [ -f "$PATCH" ] || die "patch not found at ${PATCH} (is @kybernesis/exe installed?)"

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

  down)
    require_docker
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "  ✓ ${NAME} removed. The volume ${VOLUME} keeps the sign-in for next time."
    ;;

  *)
    echo "usage: bash scripts/claude-subscription.sh {up|login|status|down|build-patched}"
    exit 1
    ;;
esac
