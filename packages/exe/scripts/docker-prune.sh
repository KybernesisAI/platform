#!/bin/sh
#
# Reclaim what the agent runtime leaves behind, on a self-hosted host.
# Ships with @kybernesis/exe and is installed by `kyb upgrade`.
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
build_cutoff=$(date -u -d "${BUILD_HOURS} hours ago" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || build_cutoff=""

echo "=== $(date -u +%FT%TZ) start ==="
df -h / | tail -1

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

# 1. Session and build containers. Running durable sessions retain the week-long
# backstop. Exited containers use durable run state first, then FinishedAt as a
# conservative idle fallback. Inspect and date failures always protect.
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

      run_id=""
      case "$name" in *-wrun_*) run_id="wrun_${name##*-wrun_}" ;; esac
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

# Delete only marker files that name the exact image reference just removed.
remove_image_markers() {
  reference=$1
  while IFS= read -r app; do
    marker_dir="$app/.eve/sandbox-cache/docker/templates"
    [ -d "$marker_dir" ] || continue
    find "$marker_dir" -type f 2>/dev/null | while IFS= read -r marker; do
      stored=$(cat "$marker" 2>/dev/null) || continue
      [ "$stored" = "$reference" ] || continue
      rm -f "$marker" && echo "removed stale sandbox template marker ${marker} (${reference})"
    done
  done < "$app_dirs"
}

# 3. Sandbox templates: preserve the existing per-checkout newest-batch rule.
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
      if [ "$when_epoch" -lt "$cutoff_epoch" ]; then
        if [ -n "$DRY_RUN" ]; then
          echo "would remove superseded sandbox template ${tag} (${image})"
        else
          # An image a container still references refuses to go: never break a live session.
          if "$DOCKER" rmi "$image" >/dev/null 2>&1; then
            echo "removed superseded sandbox template ${tag} (${image})"
            remove_image_markers "eve-sandbox-template:${tag}"
          fi
        fi
      fi
    done
done

# 4. Dangling layers.
[ -n "$DRY_RUN" ] || "$DOCKER" image prune -f

df -h / | tail -1
echo "=== done ==="
