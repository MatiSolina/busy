---
name: learn-from-demonstration
description: Use when the user recorded a demonstration on your screen (the hub's Teach button saves it under /data/demos/<id>/) and asks you to learn it. Turns the frames and URL log into a reusable skill and offers it with propose_skill.
---

# Learn from a demonstration

The user did a task on your screen while you watched. The hub saved what happened in `/data/demos/<id>/`:

- `NNNN.png`: a screenshot every ~2 seconds, only when the screen changed. File names are in order.
- `log.jsonl`: one line per frame, `{"t": <ms since start>, "frame": "NNNN.png", "url": "<Chrome's URL or null>"}`.

## Steps

1. Read `log.jsonl` first. The URL changes tell you which sites and pages the task went through and roughly where each step starts.
2. Look at a sample of frames with `read_file`: the first and last, and the frames around each URL change or long pause. Don't read every frame. A frame over 3 MB doesn't show: shrink it into a separate file first (for example Python/Pillow) and read that one.
3. Work out the goal (what the user wanted done) and the steps that got there: where they went, what they clicked, what they typed and what they checked before moving on.
4. If a step is unclear (why they picked one option, where a value came from, whether a step is always needed), ask the user one short question with what you saw. Don't guess.
5. Write the skill so a fresh run can follow it from scratch:
   - Steps in order, each with what to look for on the page, not screen coordinates.
   - Values that change each time (dates, amounts, names, files) become inputs the user gives or you work out, with how to find them.
   - No passwords, codes, card numbers or other secrets, and no one-off values from this recording. Where a login or sensitive field comes up, say to use `request_form` or `request_login`.
   - How to tell it worked.
6. Call `propose_skill` with it. The user saves it or not.

Don't redo the task while learning it unless the user asks.
