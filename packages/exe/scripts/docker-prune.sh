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
#   840MB-2.5GB each. A second agent reached 94% full and started failing in
#   ways that looked like anything but a disk problem.
#
#   Session CONTAINERS stay around too: eve keeps one per durable session so a
#   conversation can be resumed. Terminal hooks remove sessions that finish,
#   but a busy agent still accumulates exited containers whose durable run is
#   running, missing, or unreadable, and failed cleanup otherwise leaks forever.
#
# WHAT IS NEVER TOUCHED: volumes (a Claude subscription sign-in lives in one),
# a recently used template marker, any image a running container depends on,
# a running session inside its backstop, and anything this script cannot inspect
# safely enough to authorize deletion.
#
# KYB_PRUNE_DRY_RUN=1 reports every decision and removes nothing.
set -u

DOCKER="${EVE_DOCKER_PATH:-docker}"
command -v "$DOCKER" >/dev/null 2>&1 || exit 0

DRY_RUN="${KYB_PRUNE_DRY_RUN:-}"
SESSION_HOURS="${KYB_PRUNE_SESSION_HOURS:-168}"
IDLE_HOURS="${KYB_PRUNE_IDLE_HOURS:-24}"
BUILD_HOURS="${KYB_PRUNE_BUILD_HOURS:-6}"
GRACE_HOURS="${KYB_PRUNE_TEMPLATE_GRACE_HOURS:-48}"
MARKER_DAYS="${KYB_PRUNE_TEMPLATE_MARKER_DAYS:-7}"

app_dirs=$(mktemp)
templates=$(mktemp)
cleanup() { rm -f "$app_dirs" "$templates"; }
trap cleanup EXIT HUP INT TERM

add_app_dir() {
  [ -n "$1" ] || return
  grep -Fqx "$1" "$app_dirs" 2>/dev/null || printf '%s\n' "$1" >> "$app_dirs"
}
if [ -n "${EVE_APP_DIRS:-}" ]; then
  old_ifs=$IFS
  IFS=:
  for app in $EVE_APP_DIRS; do add_app_dir "$app"; done
  IFS=$old_ifs
fi
[ -n "${EVE_APP_DIR:-}" ] && add_app_dir "$EVE_APP_DIR"
if [ ! -s "$app_dirs" ]; then add_app_dir "$(pwd)"; fi

now_epoch=$(date -u +%s 2>/dev/null) || now_epoch=""
session_cutoff=""
idle_cutoff=""
[ -n "$now_epoch" ] && session_cutoff=$((now_epoch - SESSION_HOURS * 3600))
[ -n "$now_epoch" ] && idle_cutoff=$((now_epoch - IDLE_HOURS * 3600))
marker_cutoff=""
[ -n "$now_epoch" ] && marker_cutoff=$((now_epoch - MARKER_DAYS * 86400))
build_cutoff=$(date -u -d "${BUILD_HOURS} hours ago" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || build_cutoff=""

echo "=== $(date -u +%FT%TZ) start ==="
df -h / | tail -1

# A real Eve container adds a scope suffix after the workflow ULID, for example
# -__root__ or -subagents-builder. Only the exact wrun_ token maps to the run
# store; malformed names stay unknown and can never authorize "missing".
container_run_id() {
  printf '%s\n' "$1" | sed -n 's/^.*-\(wrun_[0-9A-Z]\{26\}\)-.*$/\1/p'
}

# Print terminal, running, missing, or unknown for a workflow run id. Missing is
# conclusive only when at least one run store was readable and none was unsafe.
run_state() {
  run_id=$1
  readable_dirs=0
  unsafe=0
  found=0
  combined=""
  while IFS= read -r app; do
    runs="$app/.eve/.workflow-data/runs"
    [ -d "$runs" ] || continue
    if ! ls "$runs" >/dev/null 2>&1; then
      unsafe=1
      continue
    fi
    readable_dirs=$((readable_dirs + 1))
    file="$runs/$run_id.json"
    [ -e "$file" ] || continue
    found=$((found + 1))
    text=$(cat "$file" 2>/dev/null) || {
      unsafe=1
      continue
    }
    state=$(printf '%s' "$text" | awk '
      { all = all $0 }
      END {
        rest = all; count = 0; value = ""
        while (match(rest, /"status"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
          item = substr(rest, RSTART, RLENGTH)
          sub(/^.*:[[:space:]]*"/, "", item); sub(/"$/, "", item)
          value = item; count++; rest = substr(rest, RSTART + RLENGTH)
        }
        if (count == 1) print value; else exit 1
      }') || {
      unsafe=1
      continue
    }
    case "$state" in running|completed|failed|cancelled) ;; *) unsafe=1; continue ;; esac
    if [ -z "$combined" ]; then combined=$state
    elif [ "$combined" != "$state" ]; then unsafe=1
    fi
  done < "$app_dirs"

  if [ "$unsafe" -ne 0 ]; then echo unknown
  elif [ "$found" -gt 0 ]; then
    case "$combined" in completed|failed|cancelled) echo terminal ;; running) echo running ;; *) echo unknown ;; esac
  elif [ "$readable_dirs" -gt 0 ]; then echo missing
  else echo unknown
  fi
}

remove_session() {
  id=$1 name=$2 reason=$3 running=$4
  if [ -n "$DRY_RUN" ]; then
    echo "would remove session container ${name} (${reason})"
    return
  fi
  [ "$running" = 1 ] && "$DOCKER" stop "$id" >/dev/null 2>&1
  "$DOCKER" rm "$id" >/dev/null 2>&1 && echo "removed session container ${name} (${reason})"
}

# 1. Session and build containers.
#
# A resumable conversation can legitimately keep a running container for days,
# so running durable sessions retain the week-long backstop. Exited containers
# are different: a terminal or conclusively absent durable run is dead now;
# running or uncertain durable state falls back to FinishedAt and the short idle
# horizon. A container that restarts between listing and removal wins because
# session removal is deliberately not forced. Inspect failures protect: not
# knowing a role, run record, creation time, or finish time is never permission
# to remove a container.
"$DOCKER" ps -a --format '{{.ID}}|{{.Names}}|{{.CreatedAt}}|{{.Status}}' 2>/dev/null |
  while IFS='|' read -r id name created status; do
    [ -z "$id" ] && continue
    role=$("$DOCKER" inspect --format '{{ index .Config.Labels "eve.sandbox.role" }}' "$id" 2>/dev/null) || {
      echo "skipping container ${name}: inspect failed"
      continue
    }
    when=$(echo "$created" | awk '{print $1" "$2}')
    case "$status" in Up*) running=1 ;; *) running=0 ;; esac

    if [ "$role" = "session" ] || [ "${name#eve-sbx-ses-}" != "$name" ]; then
      if [ "$running" = 1 ]; then
        created_epoch=$(date -u -d "$when" +%s 2>/dev/null) || created_epoch=""
        if [ -n "$session_cutoff" ] && [ -n "$created_epoch" ] && [ "$created_epoch" -lt "$session_cutoff" ]; then
          remove_session "$id" "$name" "created ${when}, older than ${SESSION_HOURS}h" 1
        else
          echo "keeping running session container ${name} (created ${when})"
        fi
        continue
      fi

      run_id=$(container_run_id "$name")
      state=unknown
      [ -n "$run_id" ] && state=$(run_state "$run_id")
      case "$state" in
        terminal) remove_session "$id" "$name" "workflow run ${run_id} is terminal" 0; continue ;;
        missing) remove_session "$id" "$name" "workflow run ${run_id} is conclusively missing" 0; continue ;;
      esac

      finished=$("$DOCKER" inspect --format '{{.State.FinishedAt}}' "$id" 2>/dev/null) || {
        echo "keeping exited session container ${name}: finished time inspect failed"
        continue
      }
      finished_epoch=$(date -u -d "$finished" +%s 2>/dev/null) || finished_epoch=""
      if [ -n "$idle_cutoff" ] && [ -n "$finished_epoch" ] && [ "$finished_epoch" -lt "$idle_cutoff" ]; then
        remove_session "$id" "$name" "finished ${finished}, idle more than ${IDLE_HOURS}h; run state ${state}" 0
      else
        echo "keeping exited session container ${name} (finished ${finished}; run state ${state})"
      fi
      continue
    fi

    if [ "$role" = "template-build" ] || [ "${name#eve-sbx-tpl-}" != "$name" ]; then
      if [ "$running" = 1 ] && { [ -z "$build_cutoff" ] || [ ! "$when" \< "$build_cutoff" ]; }; then
        continue
      fi
      if [ -n "$DRY_RUN" ]; then
        echo "would remove template build container ${name} (created ${when})"
      else
        "$DOCKER" rm -f "$id" >/dev/null 2>&1 && echo "removed template build container ${name} (created ${when})"
      fi
      continue
    fi

    if [ "$running" = 0 ]; then
      if [ -n "$DRY_RUN" ]; then
        echo "would remove stopped container ${name} (created ${when})"
      else
        "$DOCKER" rm "$id" >/dev/null 2>&1 && echo "removed stopped container ${name} (created ${when})"
      fi
    fi
  done

# 2. Build cache.
[ -n "$DRY_RUN" ] || "$DOCKER" builder prune -af

# Marker identity is the exact template tag path. Once an image is actually
# gone, remove only that tag's markers; failed removals and kept images retain
# every marker, and dry-run reaches neither mutation.
remove_image_markers() {
  tag=$1
  while IFS= read -r app; do
    marker="$app/.eve/sandbox-cache/docker/templates/$tag"
    [ -e "$marker" ] || continue
    rm -f "$marker" && echo "removed stale sandbox template marker ${marker}"
  done < "$app_dirs"
}

# Print recent, stale, absent, or uncertain for the exact tag marker across all
# registered checkouts. A marker touched exactly at the cutoff is still recent.
marker_state() {
  tag=$1
  seen=0
  stale=0
  while IFS= read -r app; do
    marker="$app/.eve/sandbox-cache/docker/templates/$tag"
    [ -e "$marker" ] || continue
    seen=1
    [ -n "$marker_cutoff" ] || { echo uncertain; return; }
    mtime=$(stat -c %Y "$marker" 2>/dev/null) || { echo uncertain; return; }
    case "$mtime" in *[!0-9]*|'') echo uncertain; return ;; esac
    if [ "$mtime" -ge "$marker_cutoff" ]; then
      echo recent
      return
    fi
    stale=1
  done < "$app_dirs"
  if [ "$seen" -eq 0 ]; then echo absent
  elif [ "$stale" -eq 1 ]; then echo stale
  else echo uncertain
  fi
}

# 3. Sandbox templates: keep each checkout's current set, drop superseded ones.
#
# NOT "unused images older than N hours". Docker protects an image a container
# is USING, but a warm template with no session running is not in use, so blanket
# age pruning deletes the image the next turn needs and pushes rebuild cost onto
# the next caller. Nor is a fixed count safe: one checkout can have a template
# per subagent, all of them current.
#
# eve normally prewarms a checkout's templates together, so the current set
# shares a build time. Keep the newest batch (with an hour either side), plus
# anything inside the grace period. This calculation is PER CHECKOUT because a
# tag is eve-sbx-tpl-docker-<app hash>-<config hash>-<runtime hash>. Production
# and eval checkouts share one Docker daemon and rebuild on different days; a
# daemon-wide newest batch once made one checkout delete another's whole set.
# The newest batch below is therefore calculated from the full original image
# list for each app hash, before any per-image marker decision.
#
# A start also touches the exact marker for every template it currently needs.
# Keep markers touched within MARKER_DAYS even if one template was rebuilt alone:
# that isolated rebuild must not make the other recently used templates look
# obsolete. Missing or stale markers merely defer to the batch/grace rule, while
# marker stat uncertainty protects the image rather than guessing permission.
grace_epoch=$(date -u -d "${GRACE_HOURS} hours ago" +%s 2>/dev/null || echo 0)
"$DOCKER" images --filter 'reference=eve-sandbox-template' --format '{{.Tag}}\t{{.CreatedAt}}\t{{.ID}}' 2>/dev/null |
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
  [ "$batch_epoch" -lt "$cutoff_epoch" ] && cutoff_epoch=$batch_epoch
  total=$(awk -v a="$app" '$1 == a' "$templates" | wc -l | tr -d ' ')
  echo "templates for ${app}: ${total}, newest $(date -u -d "@${newest_epoch}" +%FT%TZ 2>/dev/null), keeping from $(date -u -d "@${cutoff_epoch}" +%FT%TZ 2>/dev/null)"
  awk -v a="$app" '$1 == a {print $2" "$3" "$4}' "$templates" |
    while read -r when_epoch tag image; do
      marker=$(marker_state "$tag")
      case "$marker" in
        recent)
          echo "keeping sandbox template ${tag} (${image}; marker touched within ${MARKER_DAYS}d)"
          continue
          ;;
        uncertain)
          echo "keeping sandbox template ${tag} (${image}; marker time unavailable)"
          continue
          ;;
      esac
      if [ "$when_epoch" -lt "$cutoff_epoch" ]; then
        if [ -n "$DRY_RUN" ]; then
          echo "would remove superseded sandbox template ${tag} (${image}; marker ${marker})"
        else
          # An image a container still references refuses to go, which is
          # correct: never break a live session to reclaim space.
          if "$DOCKER" rmi "$image" >/dev/null 2>&1; then
            echo "removed superseded sandbox template ${tag} (${image}; marker ${marker})"
            remove_image_markers "$tag"
          fi
        fi
      fi
    done
done

# 4. Dangling layers.
[ -n "$DRY_RUN" ] || "$DOCKER" image prune -f

df -h / | tail -1
echo "=== done ==="
