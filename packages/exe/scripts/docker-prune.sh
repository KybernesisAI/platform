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
#
# KYB_PRUNE_DRY_RUN=1 reports every decision and removes nothing.
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
        if [ -n "${KYB_PRUNE_DRY_RUN:-}" ]; then
          echo "would remove stale session container ${name} (created ${when})"
        else
          echo "removing stale session container ${name} (created ${when})"
          docker rm -f "$name" >/dev/null 2>&1
        fi
      fi
    done
fi

# 2. Whatever is already stopped.
[ -n "${KYB_PRUNE_DRY_RUN:-}" ] || docker container prune -f

# 3. Build cache — nothing depends on it, and a Rust or browser build leaves GBs.
[ -n "${KYB_PRUNE_DRY_RUN:-}" ] || docker builder prune -af

# 4. Sandbox templates: keep each checkout's current set, drop superseded ones.
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

# 5. Dangling layers — untagged, unreferenced, and nothing will ever want them.
[ -n "${KYB_PRUNE_DRY_RUN:-}" ] || docker image prune -f

df -h / | tail -1
echo "=== done ==="
