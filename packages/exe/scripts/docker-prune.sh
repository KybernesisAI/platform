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
#   Worse, session CONTAINERS are left RUNNING. `docker container prune` only
#   removes stopped ones, so a container from a turn that ended days ago sits
#   there holding its writable layer forever. Seven such containers were found
#   across four agents, the oldest four days old — for turns that took minutes.
#
# WHAT IS NEVER TOUCHED: volumes (a Claude subscription sign-in lives in one),
# any image a running container depends on, and any session container younger
# than the cutoff — that one might be a turn in flight.
set -u

CUTOFF_HOURS="${KYB_PRUNE_SESSION_HOURS:-24}"

command -v docker >/dev/null 2>&1 || exit 0

echo "=== $(date -u +%FT%TZ) start ==="
df -h / | tail -1

# 1. Abandoned session containers. A turn lasts minutes; anything older than the
#    cutoff belongs to a session nobody is waiting on. Stopped first so the
#    layer is released, then removed.
cutoff=$(date -u -d "${CUTOFF_HOURS} hours ago" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || cutoff=""
if [ -n "$cutoff" ]; then
  docker ps -a --filter 'name=eve-sbx-ses' --format '{{.Names}}|{{.CreatedAt}}' 2>/dev/null |
    while IFS='|' read -r name created; do
      [ -z "$name" ] && continue
      # CreatedAt is "2026-08-25 10:12:33 +0000 UTC"; the first two fields sort
      # lexically against the cutoff because both are zero-padded UTC.
      when=$(echo "$created" | awk '{print $1" "$2}')
      if [ "$when" \< "$cutoff" ]; then
        echo "removing stale session container ${name} (created ${when})"
        docker rm -f "$name" >/dev/null 2>&1
      fi
    done
fi

# 2. Whatever is already stopped.
docker container prune -f

# 3. Build cache — nothing depends on it, and a Rust or browser build leaves GBs.
docker builder prune -af

# 4. Sandbox templates: keep the current set, drop superseded ones.
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
GRACE_HOURS="${KYB_PRUNE_TEMPLATE_GRACE_HOURS:-48}"
newest=$(docker images --filter 'reference=eve-sandbox-template' --format '{{.CreatedAt}}' 2>/dev/null |
  sort -r | head -1 | awk '{print $1" "$2}')
if [ -n "$newest" ]; then
  newest_epoch=$(date -u -d "$newest" +%s 2>/dev/null || echo 0)
  cutoff_epoch=$(date -u -d "${GRACE_HOURS} hours ago" +%s 2>/dev/null || echo 0)
  batch_epoch=$((newest_epoch - 3600))
  # Whichever window is more generous wins: the current batch is never at risk.
  [ "$batch_epoch" -lt "$cutoff_epoch" ] && cutoff_epoch=$batch_epoch
  docker images --filter 'reference=eve-sandbox-template' --format '{{.CreatedAt}}\t{{.ID}}' 2>/dev/null |
    while IFS="$(printf '\t')" read -r created image; do
      [ -z "$image" ] && continue
      when=$(echo "$created" | awk '{print $1" "$2}')
      when_epoch=$(date -u -d "$when" +%s 2>/dev/null || echo 0)
      if [ "$when_epoch" -lt "$cutoff_epoch" ]; then
        # An image a container still references refuses to go, which is correct:
        # never break a live session to reclaim space.
        docker rmi "$image" >/dev/null 2>&1 && echo "removed superseded sandbox template ${image} (${when})"
      fi
    done
fi

# 5. Dangling layers — untagged, unreferenced, and nothing will ever want them.
docker image prune -f

df -h / | tail -1
echo "=== done ==="
