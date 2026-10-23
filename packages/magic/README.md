# @kybernesis/magic

Proactive agents. The agent notices what matters in a person's day and tells them first, in the conversation they already have with it: a morning brief, prep before a meeting, time to leave with live traffic, a double booking, an important email still waiting on a reply, mail from someone who always matters, and one-off reminders.

It is off until each person turns it on for themselves, and it is quiet by design: quiet hours, a daily budget, a cooldown per kind, nothing while they are mid-conversation or in a meeting, and a feedback dial ("fewer of these", "stop the X ones") that also slows a kind down on its own after three misses.

## How it works

```
every 5 min   tick()                         code only, no model
              ├─ read calendar + mail as the person (control-plane connectors, throttled)
              ├─ live travel for in-person events (Google Routes, optional)
              ├─ detect()  → moments            brief, prep, leave, conflict, reply owed, VIP mail, reminder
              └─ gate()    → deliver | digest | hold | drop
when one passes
              to(channel, the person's own conversation).send(packet, { auth: the person })
              → the model checks, writes at most three lines, or calls no_reply
```

- **Runs as the person.** A schedule may send with a user principal, so the background turn has that person's connectors and grants, memory, and push notifications, and nobody else's.
- **Where it lands.** A hook records the conversation each person last wrote in. Studio and the phone share the agent's canonical conversation through the `kyb` channel; an iMessage thread through Linq is one more branch in `agent/lib/magic-surfaces.ts`.
- **Silence by default.** Most ticks find nothing. When one does, the model still decides, with `no_reply` available.
- **At most once.** A moment is recorded before it is sent, so a crash loses a heads-up rather than repeating one.
- **State on disk.** One directory per person under `<app>/.kyb/magic/people/`, each file written whole and renamed into place.

## Install

```sh
eve add @kybernesis/magic
```

That writes the tick (`agent/schedules/magic.ts`), the delivery map (`agent/lib/magic-surfaces.ts`), the hook, four tools (`magic_settings`, `remind_me`, `magic_status`, `magic_feedback`), `no_reply`, a dynamic instruction and the onboarding skill. It needs the agent's `kyb` channel (`@kybernesis/manage`), connectors for calendar and mail, and `@kybernesis/notify` for phone pushes.

Environment: `KYBERNESIS_ISSUER` and `KYBERNESIS_AGENT_CREDENTIAL` (already set on a provisioned agent). `GOOGLE_MAPS_API_KEY` is optional: with it, time-to-leave uses live traffic from the Routes API; without it, the person's own travel estimate, and the agent says it is one.

Then a person says "keep an eye on my day" and the agent sets it up with them.

## Entry points

| Import | What | Node builtins |
| --- | --- | --- |
| `@kybernesis/magic` | types, profile, detectors, gate, ledger, packet, parsers, instructions | no |
| `@kybernesis/magic/steps` | file store, connector reads, travel, `tick()`, `recordTurn()` | yes |
| `@kybernesis/magic/tools` | the four tools, the hook, the dynamic instruction | yes |

## Not yet

Flight status, location beyond named places, acting on its own (the ladder stops at draft), and a control-plane switch for whole companies.
