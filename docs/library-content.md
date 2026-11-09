# Library content addressing

Busy keeps a file reference for each bot, filename, version and chat source. A
reference controls who may see the file. The physical bytes are represented by a
`library_objects` row and can be shared by references from different bots only
after the server has hashed the Blob bytes.

The browser never establishes a digest. It reserves a private Blob pathname and
uploads directly to Blob. Completion checks the Blob with a short-lived signed
`HEAD` request and compares `Content-Length` with the reserved size. The
reference becomes `ready` at that point, so a large upload does not wait for a
Function to stream hundreds of megabytes before the chat can use it.

After completion, `verifyFileWorkflow` streams the object through the server,
computes SHA-256, and takes a Postgres advisory lock derived from that digest.
It copies the first verified object to `library/sha256/<prefix>/<digest>`,
creates or reuses the unique `library_objects` row, and updates the reference
with `object_id`. Duplicate uploads keep their own filename/version and become
references to the same physical pathname. A failed workflow leaves the ready
reference usable with `object_id` null; the 15-minute verification cron retries
it. This is at-least-once processing, not exactly-once execution.

Promotion checks the canonical Blob while holding the digest lock. If a prior
cleanup crashed after deleting the Blob but before committing its row deletion,
the verified upload is copied back to the canonical pathname before the
reference is attached.

Bot provenance is best effort but server-derived: bot file routes accept a
session header only when it equals the bot's current persisted Eve session.
Unknown or rotated session values remain null. A delivery ID is not treated as
a turn ID. Message UUID linkage remains an explicit reference field and must be
stamped by the message ingestion path when that path has the verified message
identity.

A stale pre-dedup upload is deleted after its reference commits to the
canonical object, only when no `files.pathname` still points at it and never
when it is itself canonical. Failures leave the old upload recoverable for a
later sweep.

## Lifecycles

A file reference (`files` row):

- `pending` (reserved): the row and its id exist before the signed PUT URL.
  New reservations live at `bots/<botId>/<fileId>-<name>`, never derived from
  the slug or version, so a late upload of a deleted bot, or of another
  reservation, cannot land on a path someone else needs. Legacy rows keep their
  `bots/<slug>/<version>-<name>` path; readers always use `files.pathname`.
  `pending_until` is the PUT URL's 15 minutes plus a 45-minute grace.
- `ready`: completion checked the Blob before `pending_until`, while the bot was
  not being deleted. `ready` with `object_id` null is "verification pending";
  the cron promotes it.
- promoted: `object_id` set, `pathname` canonical, the old upload kept as
  `stale_pathname` until `stale_until` (signed read URLs), then deleted.
- `blocked`: a bot artifact that failed the safety scan. Terminal, never
  promoted; its path is cleaned like a stale one.
- expired: `pending` past `pending_until`. Completion can no longer publish it
  (both sides compare against the database clock). The cron deletes its Blob
  when no other row names the path, then the row; a Blob failure keeps the row
  for the next run.

A shared object (`library_objects` row): created `ready` and referenced in the
same transaction that attaches the first file; it stays while any file has its
`object_id` (or names its path). The 15-minute library verification cron
collects every unreferenced object in a bounded batch, not a list captured by
a caller: each candidate is rechecked in its own short transaction under the
digest advisory lock that promotion takes, so a reference attached after the
candidate was listed keeps it. Running the sweep twice is a no-op.

## Bot deletion

`DELETE /api/bots/[slug]` answers `202` once the bot row is marked `deleting`
with a deletion token (`lib/bots/deletion.ts`). From then on the row keeps the
slug reserved (a new bot gets a suffix), uploads, completions and promotions
are refused, and `deleteBotWorkflow` runs idempotent steps fenced by the token:
code tasks (wiring point for the code-task shutdown), the Vercel project by the
id captured once on the row (never by name), schedules by the `bot-<botId>`
namespace, Blobs by the id prefix plus the legacy slug prefix (sparing any path
another bot's row names). It then writes a `bot_tombstones` row (old id, slug,
project id; not unique by slug) and hard-deletes the bot row. Events, cursors,
messages, files, memories and the consultations the bot opened cascade
(migration 0029); a consultation another bot opened towards it keeps a NULL
receiver and is shown as "otro bot". Thirty minutes later the bot's folders are
swept once more for late uploads.

A failed run records `deletion_attempts`, `deletion_last_error` and a backoff in
`deletion_next_attempt_at`; the library verification cron restarts due
deletions, also those whose workflow never started. After 8 attempts the row is
`attention`: still reserved and not live, until someone deletes the bot again,
which re-arms it with the same token.

Migration 0029 never deletes rows. A legacy orphan (a row whose bot no longer
exists) keeps its foreign key `NOT VALID` and is reported with a `NOTICE`. To
review them before or after applying it:

```sql
SELECT 'events' AS t, count(*) FROM events e WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.id = e.bot_id)
UNION ALL SELECT 'cursors', count(*) FROM cursors c WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.id = c.bot_id)
UNION ALL SELECT 'messages', count(*) FROM messages m WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.id = m.bot_id)
UNION ALL SELECT 'files', count(*) FROM files f WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.id = f.bot_id)
UNION ALL SELECT 'memories', count(*) FROM memories m WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.slug = m.bot_slug)
UNION ALL SELECT 'consultations.from', count(*) FROM consultations c WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.id = c.from_bot_id)
UNION ALL SELECT 'consultations.to', count(*) FROM consultations c WHERE c.to_bot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.id = c.to_bot_id);
```

Removing an orphan matches what deleting its bot would have done (its own
events, cursors, messages, files, memories and consultations it opened). Do it
as a reviewed decision, then apply 0029 again to validate the constraints.
Orphan `files` rows also hold Blob paths: list them first and let the cron's
object GC collect their shared objects afterwards.
