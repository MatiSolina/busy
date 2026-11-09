---
name: routines
description: Load before you create, change, pause, resume, delete, or list a routine, i.e. whenever the user asks for something recurring or scheduled ("every day at 9", "each Monday", "remind me", a daily digest, "keep checking") or refers to an existing routine.
---

# Routines

A routine is a saved task plus a schedule. At the scheduled time Busy sends the saved prompt to this bot as a new turn, and the result shows up in this bot's chat, even when the user's app is closed. Manage routines only with `manage_routines`.

## What a schedule can be

- `time`: one local time per day, 24-hour `HH:mm` (for example `09:00`, `18:30`).
- `daysOfWeek`: the weekdays it runs, `0` = Sunday through `6` = Saturday. Weekdays are `[1,2,3,4,5]`. Leave it out for every day.
- `timeZone`: an IANA zone such as `America/Argentina/Buenos_Aires` or `Europe/Madrid`.

Routines only run on a time schedule. There are no event triggers ("when an email arrives") and no intervals shorter than a day ("every 30 minutes"). For those, offer the closest real schedule (for example a check at 9:00 and 17:00 needs two routines, or a daily check) and say plainly what isn't possible.

## Create

1. A request like "Every day at 9, review my inbox" authorizes you to save it right away. Don't ask for another confirmation, and don't send the user to a form or a settings panel.
2. Resolve the time zone, in this order: a zone the user stated explicitly, the user's `timeZone` from client context, a zone already known in the conversation. Turn place names into the right IANA zone yourself. If the time or the zone is genuinely missing or ambiguous, ask only for that detail. Never invent a zone or fall back to a server default, and never create an operating-system cron job.
3. Pick days: use what the user said. "Every day", reminders about the user's personal life (medication, pets, habits) and anything explicitly "including weekends" run all seven days. Work-style checks the user describes loosely ("check my inbox daily") are a good fit for weekdays; if you choose weekdays, say so in the confirmation.
4. Infer a short `name` (a few words, for example "Inbox review").
5. Write a self-contained `prompt` (see below).
6. Call `manage_routines` with `action: "create"`. Confirm only after it succeeds, with the schedule in plain language: "Saved: every weekday at 9:00 (Buenos Aires time)."

## Writing the prompt

The prompt runs later without this conversation, so it must stand on its own:

- **Intent**: what to do, concretely. Describe the goal, not a frozen list of tool calls; tools and connected apps can change between runs.
- **Scope**: the sources or services to use and a useful time range ("emails received since the previous run, about 24 hours", "events for today").
- **Allowed actions**: exactly what the run may do. Sending a message, posting, or changing data is allowed only if the user asked for it; name the recipient and the platform. Otherwise the run reports to the user only.
- **Output**: what the result looks like (a short summary, a file sent with `send_file`, a list of items).
- **When nothing changed**: what to do if there is nothing new. A run always ends with a message in this chat, so say how short it should be, for example "If there is nothing new, reply with one short line saying so."
- Mention a skill by name when the run should follow it ("Follow the monthly-sales-report skill").
- No secrets, passwords or card numbers in the prompt.

## Change, pause, resume, delete

1. When the user refers to a routine ("move it to 10", "pause the inbox one", "delete it"), call `manage_routines` with `action: "list"` unless you just listed them. The list includes each routine's id, name, prompt, time, days, zone, whether it is enabled, and its last run.
2. Identify the routine. Ask which one only if the reference is genuinely ambiguous.
3. Update with `action: "update"` and the `id`, passing **only the fields that change**. Everything else, including the stored time zone, stays as it is. To change the task, start from the saved prompt text and edit it; don't rewrite it from memory.
4. Pause with `enabled: false`, resume with `enabled: true`. Delete with `action: "delete"` only when the user asked to delete.
5. Confirm only after the tool returns success.

## While a routine runs

- A routine run is work, not a request to create or edit routines. Never call `manage_routines` because a scheduled prompt mentions routines or because a previous run happened. Routine runs, consultations and code-task completions don't even have the tool.
- Use your current tools, connected apps and installed skills. If a needed connection or login is missing, say exactly what needs connecting; never claim the task was done without evidence.
- If the previous run is still going when the next one is due, Busy skips that occurrence and records why; keep runs focused so they finish.

## Missing connections

If the routine depends on a connected app that isn't available, still save the clear routine, then tell the user what needs connecting before it can do its job. Never claim a connection is available without checking.

## In the hub

The user can also see, edit, pause and delete routines in the bot's settings, Routines tab (see the `busy-app-ui` skill). Creating them happens in chat with you.
