#!/usr/bin/env bash
# Supervise a self-hosted eve agent.
#
# Two things this exists to get right, both of which cost real debugging time:
#
# 1. LOG CAPTURE. `eve start` spawns the built Nitro server as a grandchild and
#    forwards only its startup banner — request and turn lines never reach a
#    redirected log file, so the log looks frozen at boot while the agent is
#    happily serving. We run `.output/server/index.mjs` directly (which is what
#    `eve start` ultimately executes) so every line lands in the log.
#
# 2. STOPPING SAFELY. `pkill -f <pattern>` run over SSH matches the SSH command
#    line itself and kills your own session — and, if the pattern is broad, the
#    agent too. We track a pidfile and kill by PID.
#
# Also: `eve start` does NOT read .env.local the way `eve dev` does. This script
# exports it into the process.
set -u
APP="${EVE_APP_DIR:-$(pwd)}"
PIDFILE="$APP/.eve/server.pid"
LOG="${EVE_LOG:-$APP/server.log}"
PORT="${PORT:-8000}"

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

stop() {
  if is_running; then
    local pid
    pid="$(cat "$PIDFILE")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

start() {
  cd "$APP" || exit 1
  if [ ! -f .output/server/index.mjs ]; then
    echo "no build at $APP/.output — run: npx eve build" >&2
    exit 1
  fi
  mkdir -p "$APP/.eve"
  set -a
  # shellcheck disable=SC1091
  [ -f .env.local ] && . ./.env.local
  set +a
  setsid env PORT="$PORT" node .output/server/index.mjs < /dev/null >> "$LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    echo "started pid=$pid port=$PORT log=$LOG"
  else
    echo "FAILED to start — last lines of $LOG:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
}

status() {
  if is_running; then
    echo "running pid=$(cat "$PIDFILE")"
    # Durable truth about work done, independent of log capture.
    local runs
    runs=$(find "$APP/.eve/.workflow-data/runs" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    echo "workflow runs on disk: $runs"
  else
    echo "not running"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop; echo stopped ;;
  restart) stop; start ;;
  status) status ;;
  logs) tail -n "${2:-40}" "$LOG" ;;
  *) echo "usage: $0 {start|stop|restart|status|logs [n]}"; exit 2 ;;
esac
