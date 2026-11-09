# Skills, memory, history, integrations and files

This change adapts five ideas from [fxbot](https://github.com/iammrduncan/fxbot)
to Busy's existing Eve agents, shared app capabilities and durable hub. It keeps
the current authentication, approvals, private file delivery and direct uploads.

## Scope

- Add, edit, search and remove a bot's memories, with honest source metadata.
- Search a bot's own saved conversation and memories, and read surrounding messages.
- Review integration revisions and restrict the tools available on a connection.
- Identify duplicate file content while retaining each file's name and provenance.

These capabilities share the account's existing authorization boundary. Memory
from another bot's consultation is read-only, and a file's shared physical
storage never grants another bot access to it.

## Upstream reference

Reviewed revision: `b5b2be07169bb1ac32de28fe9e92297d17ac0fc3`.
fxbot is distributed under [Apache-2.0](https://github.com/iammrduncan/fxbot/blob/b5b2be07169bb1ac32de28fe9e92297d17ac0fc3/LICENSE).
The reference implementations are its memory/history tools, MCP
registry lifecycle and content-addressed library. Busy continues to use Eve,
Drizzle, Vercel workflows and Blob/Drive; it does not include the fxbot runtime.

This PR changes source and migration files. Applying migrations, deploying the
hub and redeploying existing bot templates are separate release operations.
Local tests and synthetic browser checks do not establish production rollout.

## Release order

Apply these migrations in order before deploying the hub:

1. `0017_memory_metadata.sql`
2. `0018_history_search.sql`
3. `0019_library_objects.sql`
4. `0020_message_skill_snapshots.sql`

Then deploy the hub and redeploy existing bot templates through the normal
session-preserving path. Keep semantic indexing disabled until its provider and
model are configured. Existing file references remain usable while verification
and deduplication run in the background; existing MCP connections retain their
approval policy until their tools are explicitly discovered and reviewed.

## History search and optional semantics

The default search uses Postgres full-text search over accepted user messages,
completed primary-chat replies and current memory metadata. Consultation child
sessions are excluded by their stored session relationship. A result id must be
returned by the server's own search before the surrounding context endpoint will
read it, and context stays within the result's source/session boundary.

Semantic search is opt-in. Set `HISTORY_EMBEDDINGS_ENABLED=1` and
`HISTORY_EMBEDDING_MODEL` to use the configured Gateway/OIDC embedding endpoint;
`HISTORY_EMBEDDING_URL` and `HISTORY_EMBEDDING_API_KEY` are optional overrides.
The `history-embeddings` workflow and `/api/cron/history-embeddings` route fill
durable model/content-hash rows with leased batches. If the provider is absent,
times out or fails, the lexical result remains available and no paid call is
made unless the feature is explicitly enabled.

## MCP allowlists and catalog lifecycle

MCP connections keep the OAuth grant in the hub's encrypted row. The browser
receives only catalog metadata, reviewed tool descriptors and selected tool
names; it never receives an access or refresh token. Tool discovery runs through
the hub-side broker (`PUT /api/mcp/:id`) against the curated catalog endpoint.
The bot runtime receives the reviewed snapshot from `GET /api/bot/mcp`, while
Eve's connection approval request re-reads that endpoint before every call. A
tool can therefore be denied after it was already present in Eve session
history. The current approval policy remains in force after the ACL check,
including read-only consultations.

The catalog descriptor is versioned and hashed from its endpoint, transport,
OAuth provider/scopes and reviewed tool surface. A changed descriptor is shown
as **update available** and is not used by the bot until the user explicitly
reviews it (`POST /api/mcp/:id`). If endpoint, auth mode or scopes changed, the
encrypted tokens are cleared and the connection returns to reconnect.
Deprecated entries remain visible for existing connections; removed entries are
withheld from the bot runtime and retain their row for review/audit.

The review envelope is persisted in `oauth_data` alongside the grant, encrypted
with the connection id as associated data. This keeps OAuth material and its
review metadata server-only without adding a second exposed table. Existing
rows without the envelope are marked **legacy**: their existing approval policy
continues to run, and the UI offers an explicit tool discovery/review action.
They are never silently treated as an empty allowlist. Once discovery succeeds,
the connection switches to enforced ACL mode with read-only tools selected by
default.

Rollout order: deploy the hub, discover tools for existing connected rows, then
redeploy the bot template. Before rollout, verify one read-only call, one
unchecked tool denied at runtime, a legacy connection retaining approval-only
behavior, an allowlist revocation while a session is open, a catalog update with
unchanged scopes, and an update that forces OAuth reauthentication. Local tests
do not prove the remote OAuth provider or production OIDC deployment.

The skill picker in the message box (`$` or `/`) was removed later. The
`messages.selected_skills` column from `0020_message_skill_snapshots.sql` stays
in the database with its empty default; nothing reads or writes it now. A
request may still carry `selectedSkills` references: they only count toward the
payload hash, so a retry of a message stored with picked skills still matches.
