# Bot sections

Sections organize the hub sidebar by team, client or project. A bot belongs to
one section at a time, or to **No section**. Section names must be unique without
regard to case, contain 1–60 characters, and are trimmed before saving.

## Use

- Right-click anywhere in the Bots area and choose **Create section** to add a
  group. The same action is available in each section header's context menu; on
  touch screens, hold an empty part of the Bots area. No creation icon is shown.
- Drag a bot row onto a section to move it, or onto **No section** to unassign
  it. The destination highlights while dragging, including empty and collapsed
  sections. **No section** is hidden when no bots are unassigned and appears
  temporarily during a drag so a bot can still be removed from its section.
- On touch screens, hold a bot briefly before dragging. With a keyboard, focus
  the bot, press Space, use the arrow keys to move, then press Space to drop or
  Escape to cancel. Enter opens the chat as usual.
- Click a section's name to collapse or expand its bots. Section headers show
  only the name and disclosure arrow, with no counters or action buttons.
- Right-click a section's name (or hold it on a touch screen) to rename or delete
  it. Deleting a section removes its grouping only; its bots become unassigned
  and keep their chats and files.

Desktop and mobile navigation share the same section state. Collapsing the whole
desktop sidebar shows all bot avatars so every chat remains accessible. Moving
a bot keeps its chat mounted, including its draft and live stream. New bots start
without a section. Deleting a bot also removes its membership. The whole
collapsed sidebar remains ordinary chat navigation; expand it to move bots.

## Persistence and API

`drizzle/0014_bot_sections.sql` adds `bot_sections` and
`bot_section_memberships`. The membership primary key is `bot_id`; both foreign
keys cascade to delete memberships without deleting the other entity. Section
names have a case-insensitive unique index. The tables use RLS and revoke access
from `PUBLIC`, `anon` and `authenticated`; requests go through the hub's existing
session and same-origin write checks.

The chat page loads sections alongside bot history. Moving a bot updates the
shared navigation state immediately while the assignment saves in the background.
If saving fails, the previous grouping is restored and the error allows a retry.
Other section writes update navigation after server confirmation. Only one section
write runs at a time. Reloading the page reads the saved organization again.
Section expansion is local to each navigation instance.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/sections` | — | `{ sections: [{ id, name, botSlugs }] }` |
| `POST /api/sections` | `{ name }` | `{ section }`, status 201 |
| `PATCH /api/sections/:id` | `{ name }` | `{ section }` |
| `DELETE /api/sections/:id` | — | `{ ok: true }` |
| `PUT /api/bots/:slug/section` | `{ sectionId: UUID \| null }` | `{ ok: true }` |

Responses are private and uncached. Invalid payloads return 400, missing bots or
sections return 404, duplicate names return 409, and bodies over 16 KiB return
413. Assignment is transactional and never redeploys a bot or changes a session.

## Focused validation

```sh
pnpm exec vitest run apps/hub/sections-database.test.ts apps/hub/sections-routes.test.ts apps/hub/sections-navigation.test.tsx apps/hub/components/sections-provider.test.tsx
pnpm typecheck
pnpm lint:next
```

The database tests use PGlite to exercise the migration, constraints, membership
changes, cascades and effective grants. Component tests cover the management
actions, bot membership, failed writes, concurrent writes and draft preservation.
Drag navigation tests exercise the DnD event boundary; browser checks cover the
real pointer and keyboard sensors plus touch emulation at 390×844. Pointer
movement or a short touch gesture does not replace an ordinary click or scroll.
