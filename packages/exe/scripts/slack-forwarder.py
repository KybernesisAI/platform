#!/usr/bin/env python3
"""
Slack Socket Mode forwarder: exe.dev integration -> local eve agent.

Keeps EVERY Slack token off the VM. The exe.dev Slack Bot integration holds the
bot and app tokens server-side; this process calls `apps.connections.open`
through the integration hostname (no credentials in the request), opens the
ticketed WebSocket, and forwards each event to eve's Slack route using eve's
forwarded-socket-event contract:

    POST <eve>/eve/v1/slack
    x-slack-socket-token: $SLACK_SOCKET_FORWARDING_SECRET
    {"body": <slack payload>, "eventType": "<events_api|slash_commands|interactive>"}

eve validates the header against SLACK_SOCKET_FORWARDING_SECRET and routes the
payload exactly as if it had arrived over its own socket connection.

Env:
  EXE_SLACK_GW   e.g. https://mybot.int.exe.xyz/api/   (trailing slash)
  EVE_URL        e.g. http://127.0.0.1:8000
  SLACK_SOCKET_FORWARDING_SECRET
"""
import asyncio
import json
import os
import sys
import urllib.request

import websockets

GW = os.environ["EXE_SLACK_GW"].rstrip("/") + "/"
EVE = os.environ.get("EVE_URL", "http://127.0.0.1:8000").rstrip("/")
SECRET = os.environ["SLACK_SOCKET_FORWARDING_SECRET"]


def gw_post(method: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else b""
    req = urllib.request.Request(
        GW + method,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def forward(body: dict, event_type: str):
    # POST Slack's raw event_callback payload: we authenticate via the custom
    # webhookVerifier on eve's standard webhook path, which parses the normal
    # Slack body shape (not the adapter's socket envelope).
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{EVE}/eve/v1/slack",
        data=payload,
        headers={"Content-Type": "application/json", "x-slack-socket-token": SECRET},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"[fwd] {event_type} -> eve {resp.status}", flush=True)
    except Exception as exc:  # never let one bad event kill the loop
        print(f"[fwd] {event_type} -> eve FAILED: {exc}", flush=True)


async def run_once():
    url = gw_post("apps.connections.open")["url"]
    print(f"[gw] socket opened", flush=True)
    async with websockets.connect(url, max_size=None) as ws:
        async for raw in ws:
            msg = json.loads(raw)

            print(f"[raw] {str(raw)[:300]}", flush=True)
            env_id = msg.get("envelope_id")
            if env_id:  # ack immediately; Slack retries anything unacked
                await ws.send(json.dumps({"envelope_id": env_id}))
            mtype = msg.get("type")
            if mtype in ("hello", "disconnect"):
                print(f"[gw] {mtype}", flush=True)
                if mtype == "disconnect":
                    return
                continue
            payload = msg.get("payload") or {}
            if payload:
                forward(payload, mtype or "events_api")


async def main():
    while True:  # exe hands out single-use tickets; reconnect on drop
        try:
            await run_once()
        except Exception as exc:
            print(f"[gw] connection error: {exc}", flush=True)
        await asyncio.sleep(2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
