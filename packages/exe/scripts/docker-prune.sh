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
KEEP_IMAGE_HOURS="${KYB_PRUNE_IMAGE_HOURS:-48}"

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

# 4. Unused images past the keep window. In-use images are protected by docker
#    itself, so a warm sandbox template in active use survives this.
docker image prune -af --filter "until=${KEEP_IMAGE_HOURS}h"

df -h / | tail -1
echo "=== done ==="
