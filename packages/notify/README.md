# @kybernesis/notify

Push a notification to the person whose turn it is, through the Kybernesis
control plane.

```ts
import { askingUser, notify, preview } from "@kybernesis/notify";

const user = askingUser(ctx);
if (user) await notify({ user, issuer, credential, kind, title, body: preview(text) });
```

## Saying it is on a long job

The extension also gives the model `working_on_it` (mounted as
`notify__working_on_it`). On a text channel a person sees nothing between a
request and its answer, so before making or changing an artifact (always, since
0.4.1, because models judged a quick page not worth a note) and for other work
that takes more than a minute (a report, research, code, the computer) the
model sends one sentence first:
"On it. Building your daily calendar page now, I'll send it here in a minute."
Quick answers get no note. The tool does nothing itself; each surface posts
the call's message as it happens:

- the Buzz bridge (`@kybernesis/buzz` 0.17+) posts it in the channel as a reply;
- a Chat SDK channel, such as Linq iMessage, posts it with
  `events: progressEvents()` from `@kybernesis/cards`;
- KYBER Studio and the phone show it as the turn's live step (its label).

At most one note posts per turn.

## Which version to install

**There is one build per eve line, and the version numbers are NOT in eve
order.** A higher version can be an OLDER eve line: `0.1.1` is the eve 0.53
build and was published before `0.1.2`, the eve 0.51 one. So `npm view
@kybernesis/notify latest` is routinely the WRONG answer, and `^` on any of
these will silently cross a line boundary.

**Pin exactly. Never a caret.**

| eve line | newest build |
| --- | --- |
| `>=0.49.0 <0.50.0` | `0.1.3` |
| `>=0.51.0 <0.52.0` | `0.1.4` |
| `>=0.53.0 <0.54.0` | `0.1.1` |

To resolve this from the command line rather than from a table that can age:

```sh
npx @kybernesis/create upgrade   # carries an agent to the builds on ITS eve line
```

`kyb upgrade` reads each candidate's declared `peerDependencies.eve` and takes
the newest build that contains the eve version actually installed. It is the
only mechanism here that cannot pick a build from the wrong line.

## What `askingUser` is for

It answers "is there a person to ring?" from the verified session principal,
and returns `undefined` when there is not.

That question has a wrong answer that looks right. A principal is always
present, and it is always truthy — a schedule's turn carries `eve:app`, an eval
turn and every `eve dev` turn carry `local-dev`. Passing one of those to the
control plane is not a no-op: it answers `500`, once per turn, forever. So the
guard is default-deny — a person is a principal of type `user`, and everything
else is nobody — rather than a list of the machine types, which is what it was
at first and which `local-dev` walked straight through.

The authenticator is deliberately not part of the test. Real people arrive
through several (`kybernesis` from Studio and the clients, `slack-webhook` from
a Slack sender, a client's own provider on a self-hosted deployment), and
gating on the one you happen to see most stops the others from ever ringing.
