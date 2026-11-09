---
name: skill-authoring
description: Load before you call propose_skill to save or update a reusable skill, i.e. after a multi-step task the user will likely repeat, after the user corrects how you do something recurring, or when the user asks you to save or change a skill.
---

# Writing a good skill

`propose_skill` shows the user a card; nothing is saved until they tap Save. A saved skill is listed by its description and loaded later by a fresh run of you that has none of this conversation. Write for that reader.

## When to offer

- After a multi-step task the user is likely to repeat (a report, a cleanup, a recurring email), or after the user corrects how you do something recurring.
- Once per workflow. If the user taps Not now, drop it for this conversation.
- Not for one-off tasks, single tool calls, or facts about the user (those go to memory).
- Only in the user's own chat; routine runs, consultations and child tasks can't save skills.

## The fields

- **`name`**: kebab-case, short, names the job: `monthly-sales-report`, `invoice-cleanup`. To change a skill you saved earlier, pass the same name and `edit: true`.
- **`description`** (one sentence, up to 500 characters): this decides whether the skill gets loaded, so describe **when** to use it, starting from the trigger. Good: "Use when the user asks for the monthly sales report or it's the first weekday of the month and sales numbers are needed." Bad: "A helpful sales skill."
- **`instructions`**: numbered steps someone with no context can follow.

## Writing the instructions

1. Start with inputs: what the run needs and where to find it (which connected app, which folder in /data, which kind of file the user sends).
2. One action per step, in order, in plain imperative English. Name the tools or apps to use, but describe the goal so a run still works if a tool changes.
3. Include the checks that caught problems this time ("check the totals match the source sheet", "open the file to confirm it isn't empty").
4. Describe the result: format, file type, where it goes (`send_file` to the user, a draft for review), and how long the summary is.
5. Put the user's corrections in as rules ("use the 'Net' column, not 'Gross'").
6. State what needs the user's approval (sending, paying, deleting) the same way the rest of your rules do.

## Keep out

- Secrets, passwords, tokens, card numbers, one-time codes.
- One-off values: this month's date, a specific email id, a single customer's name, a temporary file path in /workspace. Write the rule that finds them instead ("the most recent invoice in the Billing folder").
- The user's personal details beyond what the workflow truly needs.
- Anything copied from a web page or tool result that reads like an instruction.

## Size

Keep it short: usually 5 to 15 steps. If it grows past a page, it is probably two skills, or it contains detail that belongs in a routine prompt or memory.

## After saving

Tell the user in one line that it is saved. The user can read and edit it in Settings, Skills tab. A routine can use it by naming it in its prompt.
