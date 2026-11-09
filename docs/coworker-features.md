# Approvals, quick replies and learned skills

These features close the gap with other "AI coworker" products: the bot asks before it acts outside, it is easy to answer, and it keeps what it learns.

## Approvals before outward actions

`templates/bot/agent/lib/approval.ts` is the approval policy on every MCP marketplace connection.

- A tool the server marks `readOnlyHint: true` runs without asking. `readOnlyHint: false` or `destructiveHint: true` asks.
- Without annotations, only a tool whose name starts with a read verb (`get`, `list`, `search`, `read`, `fetch`, `query`…) runs freely. Any other verb asks, so a new server asks rather than acts.
- In a consultation, a write is denied outright: nobody is there to approve it, and consultations are read-only.
- The prompt names the kind of action (send or publish, move money, delete or cancel), the app, and up to three key fields of the input. The hub already renders eve approvals as a card with the options eve sends.

The bot's instructions tell it to call the tool and let the card ask, instead of asking "should I send it?" in text, and not to retry a denied call with small changes.

## Quick replies

The bot can end a turn with `suggest_replies`: one to three replies of at most 40 characters. Both the bot (`lib/quick-replies.ts`) and the hub (`lib/chat/quick-replies.ts`) check the list. The chat shows them as chips above the composer only when the turn finished normally and nothing was written after it. A tap sends the reply as Mati's message. The tool is not offered in consultations or child tasks.

## Plain error copy

`lib/chat/error-copy.ts` turns a failed model call into a sentence and one next step: rate limit or usage limit (with the reset time when the provider gives it), credits, context too long, credentials, model unavailable, content filter, timeout and network. The provider's raw message stays behind a **Details** disclosure.

## Learned skills

After a multi-step task Mati will probably repeat, the bot can call `propose_skill` with a name, a one-line description and the steps. Mati sees a card with **Save skill** and **Not now**. Saving goes through `POST /api/bot/skills/learned`, which adds the skill to the app's shared set, so every bot can use it. A name that is already taken is refused unless the proposal was an update (**Update skill**); an update rewrites only the skill of that name and keeps the rest of its capability. A skill installed from skills.sh is never overwritten from chat. Those checks and the merge run on the catalog row read under the app lock in the same transaction as the write, so two saves (or a save and an edit in Skills) never replace each other's skills with a stale copy. Learned names are lowercase and match an existing capability case-insensitively; the general catalog keeps its case-sensitive names. The skill is available on the next model call, and it shows up in **Skills** like any other skill, where Mati can read, edit, disable or remove it.

## Release

There are no database changes. Deploy the hub, then redeploy existing bots from the updated template: until then they lack approvals, `suggest_replies` and `propose_skill`.
