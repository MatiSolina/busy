# Editable memory metadata rollout

This change keeps Eve's `fileMemory` document as the only memory store. The
hub continues to compare-and-set the versioned document, while migration
`0017_memory_metadata.sql` adds current entry provenance and an append-only
change trail.

The browser routes for a bot now support listing, substring search, adding,
editing, and deleting entries. Every browser write sends the document version
it read; a stale version receives `409` and cannot overwrite a concurrent Eve
write. Metadata and document writes run in the same transaction, using an
advisory lock for the create-first path.

Entries created before migration 0017 are presented as `legacy` with unknown
author and no learned-at date. Their database insertion timestamp is not shown
as the time the bot learned the fact.

An Eve memory backend PUT only carries document bytes and its expected version.
It therefore records the authenticated bot identity and `bot_identity_only`
source for the immediate diff. The template's `turn.completed` capture hook
then sends Eve's session and turn IDs to the hub. The hub accepts
`trusted_eve_turn` only when a persisted `turn.started` event proves the exact
bot, session, and turn; if event ingestion is behind, the metadata stays
bot-identity-only. The hook does not replace or parse Eve's document and cannot
attribute unchanged entries: only `added`/`updated` events from that document
version are eligible for attribution.

Run the focused checks from the repository root:

```sh
pnpm exec vitest run apps/hub/memory-metadata.test.ts apps/hub/memory-route.test.ts apps/hub/bot-memory-route.test.ts
pnpm exec vitest run templates/bot/agent/memory/memory.test.ts templates/bot/agent/memory/memory.flow.test.ts templates/bot/agent/memory/memory.provenance.test.ts
pnpm exec ultracite check apps/hub/lib/memory-doc.ts apps/hub/lib/memory-metadata.ts 'apps/hub/app/api/bots/[slug]/memory/route.ts' apps/hub/app/api/bot/memory/route.ts apps/hub/components/memory-sheet.tsx templates/bot/agent/memory/memory.ts
```

Apply migration 0017 before deploying the hub or regenerated bot template.
These checks use disposable PGlite databases and do not connect to a remote
database or read `.env`.
