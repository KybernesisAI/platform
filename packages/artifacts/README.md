# @kybernesis/artifacts

Pages an eve agent makes for a person: a report, a dashboard, a tracker, a plan. KYBER Studio and the phone draw each one as a card in the conversation, with an inline preview or an Open button, and list them under the agent's Artifacts. Like artifacts in a chat app, except they live on the agent's own machine and belong to the person who asked.

## Install

```bash
eve add @kybernesis/artifacts
```

That writes `agent/extensions/artifacts.ts`, which mounts the extension. The agent gets four tools: `artifacts__create`, `artifacts__update`, `artifacts__list` and `artifacts__read`, plus short instructions on when to make one. The apps read artifacts through `@kybernesis/manage` 0.25 or later, which serves `/eve/v1/kyb/artifacts`.

## How it works

- **Format.** One self-contained HTML page (inline CSS and script, data written into the page) or a markdown document. Nothing outside the page loads: the apps render it in a sandbox with no network.
- **Storage.** On the agent's host, under `ARTIFACTS_DIR` (default `~/.kybernesis/artifacts`): `<id>/meta.json` plus `v<n>.html` or `v<n>.md`. An update writes a new version under the same id. The last fifty versions keep their content.
- **Who sees it.** The signed-in person whose turn made it, and nobody else. An artifact made with no signed-in person (a routine) belongs to nobody and is shown to the people who manage the agent. "A person" is default-deny: only a principal the control plane authenticated as a user.
- **The card.** `create` and `update` return the card under `kyb`, in the shared card envelope:

  ```json
  {
    "kyb": 1,
    "card": "artifact",
    "id": "<artifact id>",
    "title": "Website, last 7 days",
    "source": "Artifact",
    "data": { "artifactId": "<id>", "version": 2, "display": "document", "format": "html", "updatedAt": "…" },
    "actions": [{ "label": "Open", "artifact": "<id>" }],
    "text": "…fallback for surfaces that draw no cards…"
  }
  ```

  The apps read it from the tool's `action.result` event. The model sees one line (`toModelOutput`), never the card. The card's id is the artifact's, so a newer version replaces the older card in place.

## Routes (in `@kybernesis/manage`)

All behind the caller's control-plane identity, like every other manage route. Anything the caller cannot see is a 404.

| Route | Answers |
| --- | --- |
| `GET /eve/v1/kyb/artifacts` | The caller's artifacts, newest first: id, title, format, display, version, createdAt, updatedAt |
| `GET /eve/v1/kyb/artifacts/:id` | One artifact with its version history |
| `GET /eve/v1/kyb/artifacts/:id/content?v=N` | The page as `text/plain` (latest without `v`), for the app to place into its own sandbox. Headers `x-artifact-version`, `x-artifact-latest`, `x-artifact-format` |

## The store

`@kybernesis/artifacts/store` exports the store on its own (`createArtifact`, `updateArtifact`, `listArtifacts`, `readArtifact`, `viewerFromContext`, `canSee`, `artifactCard`), for anything else on the host that needs to keep per-person files the same way.
