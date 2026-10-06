# @kybernesis/computer

A persistent, isolated computer for an eve agent, and the rule for when the agent uses it.

The computer is a Docker container that outlives every session: a Linux desktop
with Google Chrome, a terminal, a file manager and a durable `/workspace`. Its screen
is shared over VNC/noVNC on the agent host's loopback, so a person can open it,
watch the agent work, and take the mouse and keyboard — to sign in to a site once
(logins persist in Chrome's profile under `/workspace`), to pass a 2FA prompt, or
to finish something themselves. Secrets a person types on that screen never pass
through the model.

`computerTool()` gives the model the screen: it is eve's `computer_use` (screenshot, click,
type, scroll, keypress, launch a terminal) with one change — every result carries the
screenshot **as an image**. eve's own tool returns only a path and window text, and its
`read_file` reads PNGs as text, so an agent on eve's tool alone is blind.

## Install

```sh
eve add @kybernesis/computer
```

That writes `agent/sandbox.ts` (the computer as the agent's sandbox),
`agent/tools/computer.ts`, `agent/tools/open_browser.ts`,
`agent/tools/close_tabs.ts` and `agent/instructions/computer.ts`, and asks for:

| env | meaning |
|---|---|
| `COMPUTER_NAME` | container and volume name, one per agent (default `agent-computer`) |
| `COMPUTER_VNC_PASSWORD` | the second gate on the shared screen (the first is the host's port proxy or an SSH tunnel) |

The host needs Docker. `eve build` runs `prepare` once inside the container
(eve's desktop stack, Chrome, the launcher bar); later builds reuse it.

Watch the screen: `ssh -N -L 6080:localhost:6080 <host>` then `http://localhost:6080/vnc.html`,
or on exe.dev `https://<vm>.exe.xyz:6080/vnc.html` behind exe's sign-in.

## The rule: which surface, in which order

Same order every time: **a connected app, then a tool, then the agent's browser,
then the person's machine.**

- A service that has a connector (Gmail, Notion, Linear, Attio, GitHub, Vercel…)
  is reached through the connector, **even if it is not connected yet** — the agent
  asks the person to connect it rather than clicking through the website.
- The browser is for sites with no connector, visual workflows a connector does not
  expose, pages the person must see, and actions that must go out **as the person**
  (a post or message in their name) where a connector would act as an app.
- The person's own computer is last, approval-gated, and only for what is on it.

`COMPUTER_INSTRUCTIONS` says this to the model. `openBrowserTool()` enforces the
part models get wrong: a URL on a connector-covered host (`CONNECTOR_HOSTS`) parks
for the person's approval unless the call states an override —
`person-asked-for-browser`, `must-act-as-the-person` or `person-must-see-the-page`.
The wrong path becomes a question, never a silent browse.

```ts
import { decideBrowserUse } from "@kybernesis/computer";
decideBrowserUse({ url: "https://mail.google.com" });          // { kind: "ask", service: "gmail", … }
decideBrowserUse({ url: "https://mail.google.com", override: "must-act-as-the-person" }); // allowed
decideBrowserUse({ url: "https://example.com" });               // allowed
```

Deployments extend the host list: `openBrowserTool({ connectorHosts: { ...CONNECTOR_HOSTS, acme: ["portal.acme.example"] } })`.

## API

- `DockerComputer.environment({ name, vncPassword?, prepare?, memoryLimit? })` → `environment.open()`
- `prepareComputer(sandbox)` / `startComputer(sandbox)` — the build-time and per-session steps
- `installChrome`, `installDesktopShell`, `startDesktopShell`, `openChromeCommand(url)`
- `computerTool({ vision? })`, `openBrowserTool(options?)`, `closeTabsTool()`
- `COMPUTER_INSTRUCTIONS`, `CONNECTOR_HOSTS`, `decideBrowserUse`, `serviceForUrl`

## Filling a form without the model seeing the values

`fillOnComputer(sandbox, { pageOrigin, fields: [{ selector, value, frameUrl? }], submit? })`
types values into the page open in the computer's Chrome over DevTools
(`--remote-debugging-port`), using the native value setters so React and Vue
forms notice. It runs inside the container; the values travel on stdin and the
result names only the selectors that were filled or missing. This is the
primitive `@kybernesis/vault` (passwords, cards) and `@kybernesis/payments`
(Link's one-time card) build on: the secret goes from its store to the page and
is never a tool result, so it is never in the transcript.

## Evals

`computerSuite()` in `@kybernesis/evals`: screen reading, file and cookie persistence
across sessions, the browser guard on a connector-covered site, and (configured)
connector-first and ask-to-connect behaviour.

## Gotchas

- Commands run with `bash -c`, not a login shell: Ubuntu's `.bash_logout` returns
  non-zero and the computer-use driver reports "no command output".
- `eve eval` must run in the foreground over SSH (a detached run gets 401).
- Memory: the container is capped (`memoryLimit`, default 3g); Chrome idles near 1 GB.
  `close_tabs` exists for a reason.
