#!/usr/bin/env bash
# Start/stop the eve server on the VM. Lives on the VM so process-matching
# patterns never appear in an SSH command line (pkill -f would match the SSH
# session itself). Loads .env.local explicitly: `eve start` (production mode)
# does not read it the way `eve dev` does.
set -u
APP=/home/exedev/eve-gtm
PIDFILE=/home/exedev/eve.pid
LOG=/home/exedev/eve.log

stop() {
  pkill -f "eve start" 2>/dev/null || true
  pkill -f "nitro" 2>/dev/null || true
  rm -f "$PIDFILE"
  sleep 2
}

start() {
  cd "$APP" || exit 1
  set -a
  # shellcheck disable=SC1091
  [ -f .env.local ] && . ./.env.local
  set +a
  : > "$LOG"
  setsid env PORT=8000 npx eve start --host 0.0.0.0 < /dev/null >> "$LOG" 2>&1 &
  sleep 1
  echo "started (env: SLACK_API_URL=${SLACK_API_URL:-unset}, fwd_secret=${SLACK_SOCKET_FORWARDING_SECRET:+set})"
}

case "${1:-}" in
  stop) stop; echo stopped ;;
  start) start ;;
  restart) stop; start ;;
  *) echo "usage: $0 {start|stop|restart}"; exit 2 ;;
esac
