# Chat session recovery

Busy treats an Eve session ID and a message's Eve idempotency key as one
durable tuple. The hub writes `message_delivery_attempts` before the first
POST, including the bot, message, operation identity, and target session. It
records `sending` before network I/O, so a timeout, crash, or lost
acknowledgement retries the same tuple and never silently switches sessions.

`session_gone` is the only replacement trigger. A direct Eve `404/410` or
`session_not_active`/`session_stranded` response is a definite non-admission
when the attempt was still `reserved` or had already definitively failed. If
the attempt was `sending` or `unknown`, retirement alone is not evidence that
the message was not admitted. The hub then reads the retired session's stored
stream (`lib/chat/consumption.ts`). A consumption accepts the message there. A
readable stream without one moves it once to the replacement. An unreadable
stream leaves it pinned for reconciliation on the original session. An
accepted attempt cannot transition back to failed.

`/api/cron/message-recovery` (`lib/chat/attempts.ts`) sweeps attempts left
`unknown` or `sending` past their lease. It checks the pinned session's
evidence first, then resends the persisted envelope to that session with the
same key. It fails a message with a fixed reason only when that session is gone
and never consumed it. The sweeper never moves a message to another session.

Before a replacement becomes current, Busy stores a `session_recoveries` row.
Its bounded packet uses persisted Eve facts, recent conversation, history
lookup IDs, validated root plan observations, and an allow-listed tool summary.
Tool arguments, raw results, reasoning, provider errors, and signed file URLs
are excluded from that summary. Common credential patterns in the bounded
conversation text are redacted. Started calls without a terminal fact are
marked unknown. The packet is passed as trusted hub-owned
`clientContext.recovery` metadata; `<prior_history>` remains only as the
legacy bounded conversation seed.

The partial unique index on active recoveries is the database compare-and-set
for concurrent replacement requests. A failed packet build or session
creation never activates a replacement. Live, deploy refreshes and routines
open the main session through `lib/chat/session.ts`, which installs with the
same compare-and-set. A replacement that loses to a session another writer
installed adopts that session. Its own target is recorded in `bot_sessions`
before it is ended, so `endOrphanSessions` retries the end if eve is
unavailable. Authorization, attachment
provenance, fast-path correlation, and the bot's provider/billing choice stay
unchanged.
