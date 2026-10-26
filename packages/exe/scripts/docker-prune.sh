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
#   terminal or conclusively missing. Uncertain sessions are kept for safety.
#
# WHAT IS NEVER TOUCHED: volumes (a Claude subscription sign-in lives in one),
# a recently used template marker, any image a running container depends on,
# any session whose durable run is running or uncertain, regardless of age,
# and anything this script cannot inspect safely enough to authorize deletion.
#
# KYB_PRUNE_DRY_RUN=1 reports every decision and removes nothing.
set -u

DOCKER="${EVE_DOCKER_PATH:-docker}"
# Same seam as DOCKER, and for the same reason: a test must be able to fix the
# clock. Overriding PATH is not enough — /bin/sh is dash on Debian hosts, which
# does not resolve `date` through PATH the way bash does, so a PATH-based fake
# silently has no effect and every age rule then evaluates against the real
# now. That is what left the template rules here untested for months.
DATE="${KYB_PRUNE_DATE:-date}"
# Same seam, same reason. Everything a test needs to control is named, never
# shadowed through PATH: under dash a PATH fake is simply not picked up, so a
# suite that relies on one passes on macOS and tests nothing on the hosts this
# actually runs on.
STAT="${KYB_PRUNE_STAT:-stat}"
LS="${KYB_PRUNE_LS:-ls}"
DF="${KYB_PRUNE_DF:-df}"
command -v "$DOCKER" >/dev/null 2>&1 || exit 0

DRY_RUN="${KYB_PRUNE_DRY_RUN:-}"
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

# Whether the checkout list is AUTHORITATIVE — i.e. someone told us where the
# checkouts are, rather than us guessing from the working directory.
#
# This gates orphan removal, and the distinction is the difference between
# reclaiming dead images and deleting live ones. "No checkout claims this
# template" only means orphaned if we actually know every checkout. Run from a
# directory that happens not to be one, every template looks unclaimed — and a
# rule that deletes unclaimed templates would then delete the whole daemon.
# Observed in testing against the reference host: with the list unset, a dry run
# proposed removing all fifteen templates, including the five the live agent
# needs.
app_dirs_authoritative=0
[ -s "$app_dirs" ] && app_dirs_authoritative=1
if [ ! -s "$app_dirs" ]; then add_app_dir "$(pwd)"; fi

now_epoch=$("$DATE" -u +%s 2>/dev/null) || now_epoch=""
marker_cutoff=""
[ -n "$now_epoch" ] && marker_cutoff=$((now_epoch - MARKER_DAYS * 86400))
build_cutoff=$("$DATE" -u -d "${BUILD_HOURS} hours ago" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || build_cutoff=""

echo "=== $("$DATE" -u +%FT%TZ) start ==="
"$DF" -h / | tail -1

# Legacy names embed a run id. Current Eve names are opaque hashes;
# use the inspected sessionId label first and fall back only when absent.
container_run_id() {
  printf '%s\n' "$1" | sed -n 's/^eve-sbx-ses-.*-\(wrun_[0-9A-Z]\{26\}\)-.*$/\1/p'
}

valid_run_id() {
  [ "${#1}" -eq 31 ] && printf '%s' "$1" | LC_ALL=C grep -Eq '^wrun_[0-9A-Z]{26}$'
}

# Print terminal, running, missing, or unknown for a workflow run id. Missing is
# conclusive only with an authoritative checkout list, readable stores, and none unsafe.
run_state() {
  run_id=$1
  readable_dirs=0
  unsafe=0
  found=0
  combined=""
  while IFS= read -r app; do
    runs="$app/.eve/.workflow-data/runs"
    if [ ! -d "$runs" ]; then
      unsafe=1
      continue
    fi
    if ! "$LS" "$runs" >/dev/null 2>&1; then
      unsafe=1
      continue
    fi
    readable_dirs=$((readable_dirs + 1))
    file="$runs/$run_id.json"
    [ -e "$file" ] || continue
    found=$((found + 1))
    # Read the top-level JSON status; malformed or nested records are unsafe.
    state=$(node -e 'const fs = require("node:fs"); const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!v || Array.isArray(v) || typeof v !== "object" || typeof v.status !== "string") process.exit(1); process.stdout.write(v.status)' "$file" 2>/dev/null) || {
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
  elif [ "$readable_dirs" -gt 0 ] && [ "$app_dirs_authoritative" -eq 1 ]; then echo missing
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
  if "$DOCKER" rm "$id" >/dev/null 2>&1; then
    echo "removed session container ${name} (${reason})"
  else
    echo "WARNING: failed to remove session container ${name} (${reason})"
  fi
}

# 1. Session and build containers.
#
# Durable state alone authorizes session deletion: terminal or conclusively
# missing runs are reaped promptly. There is no idle or week-long age backstop
# for running or uncertain runs; Eve cannot recreate a deleted live container.
# Inspect failures protect live sessions; uncertain containers may need
# operator attention to reclaim disk space.
"$DOCKER" ps -a --format '{{.ID}}|{{.Names}}|{{.CreatedAt}}|{{.Status}}' 2>/dev/null |
  while IFS='|' read -r id name created status; do
    [ -z "$id" ] && continue
    role=$("$DOCKER" inspect --format '{{ index .Config.Labels "eve.sandbox.role" }}' "$id" 2>/dev/null) || {
      echo "WARNING: skipping container ${name}: role inspect failed"
      continue
    }
    when=$(echo "$created" | awk '{print $1" "$2}')
    case "$status" in Up*) running=1 ;; *) running=0 ;; esac

    if [ "$role" = "session" ] || [ "${name#eve-sbx-ses-}" != "$name" ] || printf '%s' "$name" | LC_ALL=C grep -Eq '^eve-sbx-[0-9a-f]{32}$'; then
      label=$("$DOCKER" inspect --format '{{ index .Config.Labels "eve.sandbox.tag.sessionId" }}' "$id" 2>/dev/null) || {
        echo "WARNING: keeping session container ${name}: sessionId label inspect failed"
        continue
      }
      case "$label" in
        '<no value>'|'') run_id=$(container_run_id "$name") ;;
        *) run_id=$label ;;
      esac
      if ! valid_run_id "$run_id"; then
        echo "WARNING: keeping session container ${name}: unresolvable sessionId (${label})"
        continue
      fi
      legacy_id=$(container_run_id "$name")
      if [ -n "$legacy_id" ] && [ "$label" != '<no value>' ] && [ -n "$label" ] && [ "$legacy_id" != "$run_id" ]; then
        echo "WARNING: keeping session container ${name}: conflicting sessionId label and legacy name"
        continue
      fi
      state=$(run_state "$run_id")
      case "$state" in
        terminal) remove_session "$id" "$name" "workflow run ${run_id} is terminal" "$running" ;;
        missing) remove_session "$id" "$name" "workflow run ${run_id} is conclusively missing" "$running" ;;
        *) echo "WARNING: keeping session container ${name}: workflow run ${run_id} state ${state}; no age-based deletion" ;;
      esac
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
    mtime=$("$STAT" -c %Y "$marker" 2>/dev/null) || { echo uncertain; return; }
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
grace_epoch=$("$DATE" -u -d "${GRACE_HOURS} hours ago" +%s 2>/dev/null || echo 0)
"$DOCKER" images --filter 'reference=eve-sandbox-template' --format '{{.Tag}}\t{{.CreatedAt}}\t{{.ID}}' 2>/dev/null |
  while IFS="$(printf '\t')" read -r tag created image; do
    [ -z "$image" ] && continue
    when=$(echo "$created" | awk '{print $1" "$2}')
    when_epoch=$("$DATE" -u -d "$when" +%s 2>/dev/null || echo 0)
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
  echo "templates for ${app}: ${total}, newest $("$DATE" -u -d "@${newest_epoch}" +%FT%TZ 2>/dev/null), keeping from $("$DATE" -u -d "@${cutoff_epoch}" +%FT%TZ 2>/dev/null)"
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
        absent)
          if [ "$app_dirs_authoritative" -ne 1 ]; then
            echo "keeping sandbox template ${tag} (${image}; unclaimed, but the checkout list was guessed — refusing to judge)"
            continue
          fi
          # No registered checkout claims this template, so it belongs to a
          # checkout that is gone. The batch rule below cannot reclaim these:
          # it keeps each app hash's NEWEST batch, and for an abandoned checkout
          # the whole group IS the newest batch, so every one is preserved for
          # ever. Ten such images held 8 GB on the reference host, unreferenced
          # by any container, while the daily prune reported nothing to do.
          #
          # Judged against the grace period alone, never the batch: an orphan is
          # not superseded by anything, and the only reason to keep one is that
          # it may be a fresh build whose marker has not been written yet.
          if [ "$when_epoch" -lt "$grace_epoch" ]; then
            if [ -n "$DRY_RUN" ]; then
              echo "would remove orphaned sandbox template ${tag} (${image}; no checkout claims it)"
            else
              if "$DOCKER" rmi "$image" >/dev/null 2>&1; then
                echo "removed orphaned sandbox template ${tag} (${image}; no checkout claims it)"
                remove_image_markers "$tag"
              fi
            fi
          else
            echo "keeping sandbox template ${tag} (${image}; unclaimed but built within ${GRACE_HOURS}h)"
          fi
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

"$DF" -h / | tail -1
echo "=== done ==="
