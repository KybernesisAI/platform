#!/usr/bin/env bash
#
# Install the agent as a systemd service, so it outlives the shell that started
# it — and survives a reboot, an OOM kill, or a crash.
#
# Ships with @kybernesis/exe. Run it from the agent's directory:
#
#     bash node_modules/@kybernesis/exe/scripts/install-service.sh
#
# Why this exists as a script rather than a paragraph in a runbook: every agent
# we run had this unit written by hand, and they drifted. One was missing the
# docker ordering and lost its sandboxes on every reboot; one had no crash-loop
# limit and sat "starting" forever while nobody noticed it was down. A unit is a
# small file that encodes several expensive lessons, so it belongs in the
# package with the lessons written down next to it.
set -euo pipefail

APP=${EVE_APP_DIR:-$(pwd)}
NAME=${AGENT_NAME:-$(basename "$APP")}
PORT=${PORT:-8000}
UNIT=/etc/systemd/system/${NAME}-agent.service
RESTART_COMMAND="sudo -n systemctl restart ${NAME}-agent"
MANAGE_FILE="$APP/agent/channels/kyb.ts"
LEGACY_RESTART_COMMAND='bash scripts/eve-server.sh restart'
SYSTEMD_RESTART_COMMAND="$RESTART_COMMAND"

# The first line of every unit this script writes. `kyb upgrade` refreshes a
# unit only when it carries this line: a unit written by hand — every host from
# before this installer existed — is left alone and reported, never replaced.
MANAGED_MARKER="# Managed by @kybernesis/exe install-service.sh — put host-specific settings in a drop-in (sudo systemctl edit ${NAME}-agent), not here; a refresh rewrites this file."

render_unit() {
  cat <<UNITFILE
${MANAGED_MARKER}
[Unit]
Description=${NAME} eve agent
# docker.service because sandboxes live in it: started before docker is up, the
# agent serves for minutes with every sandbox tool failing, which reads as the
# model refusing to work rather than as a boot ordering problem.
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${APP}
# Sourced the same way scripts/eve-server.sh does it, because \`eve start\` does
# NOT read .env.local the way \`eve dev\` does: set -a exports what the file
# assigns, and without it every credential in there is invisible to the server.
# Build before every start, so a restart never serves whatever .output was
# last written — a package bump, a pulled commit or a Studio install becomes
# the running agent the moment the service comes back. A failed build stops
# the start (systemd will not run ExecStart after a failed ExecStartPre), and
# with Restart=always that shows up as the crash loop below rather than as an
# agent quietly running old code.
ExecStartPre=/bin/bash -lc 'set -a && . ./.env.local && set +a && npx eve build'
ExecStart=/bin/bash -lc 'set -a && . ./.env.local && set +a && exec npx eve start --host 0.0.0.0'
Environment=PORT=${PORT}
# A build with sandbox templates to prewarm can take several minutes.
TimeoutStartSec=900
Restart=always
RestartSec=15
# A crash loop should be loud rather than infinite: five failures inside five
# minutes stops the unit, so the failure is visible in \`systemctl status\`
# instead of hidden behind a service that is always "starting".
StartLimitBurst=5
StartLimitIntervalSec=300
StandardOutput=append:${APP}/cli.log
StandardError=append:${APP}/cli.log

[Install]
WantedBy=multi-user.target
UNITFILE
}

sudo_command() {
  if [ "${KYB_NONINTERACTIVE:-0}" = "1" ]; then
    sudo -n "$@"
  else
    sudo "$@"
  fi
}

validate_agent() {
  if [ ! -f "$APP/package.json" ]; then
    echo "install-service: $APP does not look like an agent (no package.json)" >&2
    exit 1
  fi
  if [ ! -f "$APP/.env.local" ]; then
    echo "install-service: no .env.local in $APP — the agent would start with no credentials" >&2
    exit 1
  fi
}

write_unit() {
  local tmp
  tmp=$(mktemp) || exit 1
  render_unit >"$tmp"
  # A replaced unit with no copy is unrecoverable by anyone who was not
  # watching the terminal. The previous file survives beside the new one.
  if [ -f "$UNIT" ] && ! sudo_command cp -p "$UNIT" "${UNIT}.bak"; then
    rm -f "$tmp"
    return 1
  fi
  if ! sudo_command install -m 0644 "$tmp" "$UNIT"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
}

case "${1:-}" in
  --unit-path)
    [ "$#" -eq 1 ] || { echo "install-service: --unit-path takes no arguments" >&2; exit 2; }
    printf '%s\n' "$UNIT"
    exit 0
    ;;
  --print-unit)
    [ "$#" -eq 1 ] || { echo "install-service: --print-unit takes no arguments" >&2; exit 2; }
    render_unit
    exit 0
    ;;
  --managed-marker)
    [ "$#" -eq 1 ] || { echo "install-service: --managed-marker takes no arguments" >&2; exit 2; }
    printf '%s\n' "$MANAGED_MARKER"
    exit 0
    ;;
  --refresh-unit)
    [ "$#" -eq 1 ] || { echo "install-service: --refresh-unit takes no arguments" >&2; exit 2; }
    validate_agent
    write_unit || exit 1
    sudo_command systemctl daemon-reload || exit 1
    echo "install-service: ${NAME}-agent unit refreshed (service not restarted; previous unit at ${UNIT}.bak)"
    exit 0
    ;;
  "")
    ;;
  *)
    echo "install-service: unknown option: $1" >&2
    exit 2
    ;;
esac

validate_agent
write_unit || exit 1
sudo_command systemctl daemon-reload || exit 1
sudo_command systemctl enable "${NAME}-agent" >/dev/null 2>&1 || exit 1
sudo_command systemctl restart "${NAME}-agent" || exit 1

echo "install-service: ${NAME}-agent installed and started"
echo "  logs:   tail -f ${APP}/cli.log"
echo "  status: systemctl status ${NAME}-agent"

case "$RESTART_STATE" in
  migrated)
    echo "  manage: migrated agent/channels/kyb.ts to: ${RESTART_COMMAND}"
    ;;
  custom)
    echo >&2
    echo "install-service: WARNING — preserved customized restartCommand in agent/channels/kyb.ts." >&2
    echo "  systemd now owns this agent. A command that invokes scripts/eve-server.sh can start" >&2
    echo "  a second server against the same durable store. Review it and use exactly:" >&2
    echo "    restartCommand: \"${RESTART_COMMAND}\"," >&2
    echo "  This requires passwordless/noninteractive sudo; verify with:" >&2
    echo "    ${RESTART_COMMAND}" >&2
    echo "  Unlike eve-server.sh, systemctl restart does not wait for an in-flight turn;" >&2
    echo "  an install during a conversation can interrupt that turn." >&2
    ;;
  missing)
    if [ -f "$MANAGE_FILE" ]; then
      echo >&2
      echo "install-service: WARNING — management routes have no restartCommand." >&2
      echo "  Add this exact line to agent/channels/kyb.ts so Studio installs become live" >&2
      echo "  without creating a second, independently supervised server:" >&2
      echo "    restartCommand: \"${RESTART_COMMAND}\"," >&2
      echo "  This requires passwordless/noninteractive sudo. systemctl restart also does" >&2
      echo "  not wait for an in-flight turn, so an install can interrupt that turn." >&2
    fi
    ;;
esac
