#!/bin/sh
#
# Reclaim what the agent runtime leaves behind, on a self-hosted host.
#
# Ships with @kybernesis/exe. Installed to /etc/cron.daily/kyb-docker-prune by
# `kyb upgrade` on a host with docker; run it by hand any time.
#
# WHY THIS IS NEEDED, and why it is not optional on a long-lived agent host:
#
#   eve builds a sandbox TEMPLATE image per session configuration and never
#   collects the old ones. Forty accumulated on one agent in seven days, at
#   840MB–2.5GB each. A second agent reached 94% full and started failing in
#   ways that looked like anything but a disk problem.
#
#   Session CONTAINERS stay around too: eve keeps one per durable session so a
#   conversation can be resumed, and only deletes it when the session ends —
#   which by default is thirty days after it began. The session.completed
#   hook in @kybernesis/exe/sandbox-cleanup handles the ones that do end;
#   this job is the week-long backstop for the ones that just go quiet.
#
# WHAT IS NEVER TOUCHED: volumes (a Claude subscription sign-in lives in one),
# any image a running container depends on, any session container younger
# than the backstop, and any container this script cannot inspect.
#
# KYB_PRUNE_DRY_RUN=1 reports every decision and removes nothing.
set -u

CUTOFF_HOURS="${KYB_PRUNE_SESSION_HOURS:-24}"

command -v docker >/dev/null 2>&1 || exit 0

echo "=== $(date -u +%FT%TZ) start ==="
df -h / | tail -1

# 1. Session containers.
#
#    Two facts pull in opposite directions. eve leaves a session's container
#    running after the turn ends, and a session can be resumed days later —
#    a thread picked up tomorrow reattaches to the same container and its
#    /workspace, so "old" is not "dead": a 24-hour cut killed live threads.
#    But the durable session that owns a container only ends at eve's
#    sessionTimeoutMs, thirty days by default, and only THEN does the
#    session.completed hook (@kybernesis/exe/sandbox-cleanup) delete the
#    sandbox. On a busy agent that is a container per conversation for a
#    month, and a delete that fails leaks forever.
#
#    So: the hook is the primary path and reclaims a closed session at once;
#    this job is the backstop at a horizon that cannot plausibly be a live
#    thread — a week. Stopped first so the layer is released, then removed;
#    a container that restarts between the listing and the remove wins, which
#    is why this is not `rm -f`. Inspect failures protect: not knowing what a
#    container is never becomes permission to remove it.
SESSION_HOURS="${KYB_PRUNE_SESSION_HOURS:-168}"
session_cutoff=$(date -u -d "${SESSION_HOURS} hours ago" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || session_cutoff=""
# A template build lasts minutes; a build container still up hours later is a
# leak (three were found "Up 2 weeks" on one host). Nothing reattaches to one.
BUILD_HOURS="${KYB_PRUNE_BUILD_HOURS:-6}"
build_cutoff=$(date -u -d "${BUILD_HOURS} hours ago" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || build_cutoff=""
docker ps -a --format '{{.ID}}|{{.Names}}|{{.CreatedAt}}|{{.Status}}' 2>/dev/null |
  while IFS='|' read -r id name created status; do
    [ -z "$id" ] && continue
    role=$(docker inspect --format '{{ index .Config.Labels "eve.sandbox.role" }}' "$id" 2>/dev/null) || {
      echo "skipping container ${name}: inspect failed"
      continue
    }
    # CreatedAt is "2026-08-25 10:12:33 +0000 UTC"; the first two fields sort
    # lexically against a cutoff because both are zero-padded UTC.
    when=$(echo "$created" | awk '{print $1" "$2}')
    case "$status" in Up*) running=1 ;; *) running=0 ;; esac
    if [ "$role" = "session" ] || [ "${name#eve-sbx-ses-}" != "$name" ]; then
      if [ -n "$session_cutoff" ] && [ "$when" \< "$session_cutoff" ]; then
        if [ -n "${KYB_PRUNE_DRY_RUN:-}" ]; then
          echo "would remove session container ${name} (created ${when}, older than ${SESSION_HOURS}h)"
        else
          [ "$running" = 1 ] && docker stop "$id" >/dev/null 2>&1
          docker rm "$id" >/dev/null 2>&1 && echo "removed session container ${name} (created ${when}, older than ${SESSION_HOURS}h)"
        fi
      else
        echo "keeping session container ${name} (created ${when})"
      fi
      continue
    fi
    if [ "$role" = "template-build" ] || [ "${name#eve-sbx-tpl-}" != "$name" ]; then
      if [ "$running" = 1 ] && { [ -z "$build_cutoff" ] || [ ! "$when" \< "$build_cutoff" ]; }; then
        continue  # a build in progress
      fi
      if [ -n "${KYB_PRUNE_DRY_RUN:-}" ]; then
        echo "would remove template build container ${name} (created ${when})"
      else
        docker rm -f "$id" >/dev/null 2>&1 && echo "removed template build container ${name} (created ${when})"
      fi
      continue
    fi
    # Anything else: only if it is already stopped. This host is the agent's;
    # a stopped container of some other kind is nobody's, but a running one
    # is not this job's to judge.
    if [ "$running" = 0 ]; then
      if [ -n "${KYB_PRUNE_DRY_RUN:-}" ]; then
        echo "would remove stopped container ${name} (created ${when})"
      else
        docker rm "$id" >/dev/null 2>&1 && echo "removed stopped container ${name} (created ${when})"
      fi
    fi
  done

# 2. Build cache — nothing depends on it, and a Rust or browser build leaves GBs.
[ -n "${KYB_PRUNE_DRY_RUN:-}" ] || docker builder prune -af

# 3. Sandbox templates: keep each checkout's current set, drop superseded ones.
#
#    NOT "unused images older than N hours". Docker protects an image a
#    container is USING, but a warm template with no session running is not in
#    use — so a blanket age prune deletes the very template the agent needs for
#    its next turn, and the rebuild lands on whoever asked next. Observed: an
#    age prune took every template on four agents, and each rebuilt its whole
#    set on the following restart.
#
#    Nor is a fixed count right: one agent here has THIRTEEN current templates,
#    one per subagent plus the root, so "keep the newest 10" would delete three
#    live ones.
#
#    eve prewarms every template together, so the current set shares a build
#    time — twelve of Kyber's were committed in the same second. Keep everything
#    from the most recent batch (with an hour either side, since a large
#    template like the browser one lags the rest), plus anything built in the
#    last two days, and remove what came before. That is exactly the pile-up
#    this job exists for: forty images built in a week, superseded within hours.
#
#    PER CHECKOUT, not per daemon. A template tag is
#      eve-sbx-tpl-docker-<app dir hash>-<config hash>-<runtime hash>
#    and the first hash is the checkout the template belongs to. Two checkouts
#    share one Docker daemon (an agent and its eval copy — Kyber's host runs
#    both), and they prewarm on different days. Judged daemon-wide, the eval
#    checkout's newer batch made production's whole set look superseded, and
#    an earlier version of this rule deleted all thirteen of them. The "newest
#    batch" is therefore worked out separately for each app-dir hash, so one
#    checkout rebuilding can never cost another its templates.
GRACE_HOURS="${KYB_PRUNE_TEMPLATE_GRACE_HOURS:-48}"
DRY_RUN="${KYB_PRUNE_DRY_RUN:-}"
grace_epoch=$(date -u -d "${GRACE_HOURS} hours ago" +%s 2>/dev/null || echo 0)
templates=$(mktemp)
# One line per template image: <app hash> <epoch> <tag> <id>. Anything that is
# not shaped like an eve template tag is grouped under "-" and judged together,
# which is the old daemon-wide rule and the safest fallback.
docker images --filter 'reference=eve-sandbox-template' --format '{{.Tag}}\t{{.CreatedAt}}\t{{.ID}}' 2>/dev/null |
  while IFS="$(printf '\t')" read -r tag created image; do
    [ -z "$image" ] && continue
    when=$(echo "$created" | awk '{print $1" "$2}')
    when_epoch=$(date -u -d "$when" +%s 2>/dev/null || echo 0)
    app=$(echo "$tag" | awk -F- 'NF >= 7 && $1 == "eve" && $2 == "sbx" && $3 == "tpl" { print $5 }')
    echo "${app:--} ${when_epoch} ${tag} ${image}"
  done > "$templates"
awk '{print $1}' "$templates" | sort -u | while read -r app; do
  [ -z "$app" ] && continue
  newest_epoch=$(awk -v a="$app" '$1 == a {print $2}' "$templates" | sort -n | tail -1)
  batch_epoch=$((newest_epoch - 3600))
  cutoff_epoch=$grace_epoch
  # Whichever window is more generous wins: the current batch is never at risk.
  [ "$batch_epoch" -lt "$cutoff_epoch" ] && cutoff_epoch=$batch_epoch
  total=$(awk -v a="$app" '$1 == a' "$templates" | wc -l | tr -d ' ')
  echo "templates for ${app}: ${total}, newest $(date -u -d "@${newest_epoch}" +%FT%TZ 2>/dev/null), keeping from $(date -u -d "@${cutoff_epoch}" +%FT%TZ 2>/dev/null)"
  awk -v a="$app" '$1 == a {print $2" "$3" "$4}' "$templates" |
    while read -r when_epoch tag image; do
      if [ "$when_epoch" -lt "$cutoff_epoch" ]; then
        if [ -n "$DRY_RUN" ]; then
          echo "would remove superseded sandbox template ${tag} (${image})"
        else
          # An image a container still references refuses to go, which is
          # correct: never break a live session to reclaim space.
          docker rmi "$image" >/dev/null 2>&1 && echo "removed superseded sandbox template ${tag} (${image})"
        fi
      fi
    done
done
rm -f "$templates"

# 4. Dangling layers — untagged, unreferenced, and nothing will ever want them.
[ -n "${KYB_PRUNE_DRY_RUN:-}" ] || docker image prune -f

df -h / | tail -1
echo "=== done ==="
