#!/usr/bin/env bash
# Control script for the Slack socket forwarder. Lives on the VM so the
# process-matching pattern never appears in an SSH command line (pkill -f
# would otherwise match — and kill — the SSH session running it).
set -u
PIDFILE=/home/exedev/fwd.pid
LOG=/home/exedev/fwd.log
SCRIPT=/home/exedev/slack-forwarder.py

stop() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

start() {
  : > "$LOG"
  setsid env \
    EXE_SLACK_GW="${EXE_SLACK_GW}" \
    EVE_URL="${EVE_URL:-http://127.0.0.1:8000}" \
    SLACK_SOCKET_FORWARDING_SECRET="${SLACK_SOCKET_FORWARDING_SECRET}" \
    python3 -u "$SCRIPT" < /dev/null >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  echo "started pid=$(cat "$PIDFILE")"
}

case "${1:-}" in
  stop) stop; echo stopped ;;
  start) start ;;
  restart) stop; sleep 1; start ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "running pid=$(cat "$PIDFILE")"
    else
      echo "not running"
    fi
    ;;
  *) echo "usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
