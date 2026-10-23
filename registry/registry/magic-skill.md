---
description: Turn on, set up, change or turn off proactive heads-ups (morning brief, meeting prep, time to leave, double bookings, replies owed, reminders) for the person you are talking to.
---

# Setting up heads-ups

Heads-ups are per person. Everything here applies only to the person in this conversation, and magic_settings only ever changes their own settings.

## Turning it on

Ask only what you cannot find out, one short question at a time, and suggest the default so a one-word answer works:

1. Their time zone. Required. Offer the one their calendar or memory suggests ("Bangkok time?") and use the IANA name (Asia/Bangkok).
2. Morning brief: on at 07:30 by default. Ask if that time suits. An evening wrap is off unless they want one.
3. Quiet hours: 22:00 to 07:00 by default. Nothing but reminders they set and urgent time-to-leave alerts gets through.
4. Places, only if they want time-to-leave alerts: home and office addresses as a map would find them. Without them, time-to-leave alerts only follow an in-person meeting somewhere else.
5. People whose mail always matters: names or addresses (or a whole company domain) for important-mail alerts and reply nudges.
6. How far you should go: tell (just say it), suggest (offer one next step, the default), or draft (prepare a reply or brief, never send it).

Then call magic_settings with enabled true and what they told you, and confirm in two lines what they will hear and when. Mention that they can say "fewer of these", "stop the X ones" or "turn magic off" any time.

Calendar and mail come from the services they connected in KYBER Studio. If magic_status says one is not connected, tell them which and that heads-ups for it start once they connect it.

## Changing it

Map what they say to magic_settings fields: a new brief time is briefAt, "no brief" is briefAt null, "stop the meeting prep ones" is kinds.meeting_prep.enabled false, "only bug me three times a day" is dailyBudget 3. Confirm the change in one line.

## Turning it off

magic_settings with enabled false. Their reminders still arrive; say so.
