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
set -u

APP=${EVE_APP_DIR:-$(pwd)}
NAME=${AGENT_NAME:-$(basename "$APP")}
PORT=${PORT:-8000}
UNIT=/etc/systemd/system/${NAME}-agent.service

if [ ! -f "$APP/package.json" ]; then
  echo "install-service: $APP does not look like an agent (no package.json)" >&2
  exit 1
fi
if [ ! -f "$APP/.env.local" ]; then
  echo "install-service: no .env.local in $APP — the agent would start with no credentials" >&2
  exit 1
fi

sudo tee "$UNIT" >/dev/null <<UNITFILE
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
ExecStart=/bin/bash -lc 'set -a && . ./.env.local && set +a && exec npx eve start --host 0.0.0.0'
Environment=PORT=${PORT}
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

sudo systemctl daemon-reload
sudo systemctl enable "${NAME}-agent" >/dev/null 2>&1
sudo systemctl restart "${NAME}-agent"

echo "install-service: ${NAME}-agent installed and started"
echo "  logs:   tail -f ${APP}/cli.log"
echo "  status: systemctl status ${NAME}-agent"
