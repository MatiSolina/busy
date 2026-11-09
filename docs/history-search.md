# History search

Busy's history search is lexical by default and reads only server-persisted
records. It searches accepted rows in `messages`, completed primary-chat reply
facts in `events`, and current entries in `memory_metadata`. Consultation child
sessions are excluded through `consultations.child_session_id`.

The result id is opaque to callers:

- user message: `messages.id`;
- assistant event: `<sessionId>:<line>:<index>`;
- memory entry: `<botSlug>:memory:<entryId>`.

The hub validates a result id by searching the selected bot first. Context reads
include both user messages and assistant replies from the result's own primary
Eve session. User messages resolve that session through persisted delivery facts;
memories use their recorded session provenance. A result with no known session
returns no surrounding messages. Context never guesses a session by recency.

## Optional semantic index

Semantic search is disabled unless both variables are set:

```text
HISTORY_EMBEDDINGS_ENABLED=1
HISTORY_EMBEDDING_MODEL=<provider model id>
```

The default endpoint is the Vercel AI Gateway embeddings endpoint. The hub uses
`AI_GATEWAY_API_KEY` when configured, then the hub's Vercel OIDC token. A custom
`HISTORY_EMBEDDING_URL` never receives an OIDC token; it requires
`HISTORY_EMBEDDING_API_KEY`.

`history_embeddings` is the durable contract:

| Column | Meaning |
| --- | --- |
| `bot_id`, `source`, `source_id` | Stable ownership and source identity; primary key also includes `model`. |
| `session_id`, `turn_id` | Provenance for assistant events. |
| `text`, `content_hash` | Exact content that was embedded and its change detector. |
| `model`, `embedding` | Embedding model identity and JSON vector. |
| `attempts`, `next_attempt_at` | Retry state after provider failures. |
| `lease_token`, `lease_until` | Short claim fence preventing concurrent workers from claiming the same active batch. |

The durable workflow creates missing rows, claims at most 32 rows with
`FOR UPDATE SKIP LOCKED`, calls the provider, verifies vector count/index/order,
finite numeric values and consistent dimensions, then clears the lease. A
provider failure releases the lease with a five-minute retry time. Search reads
only the selected bot, the current model and rows whose source still exists with
its current content hash. Semantic candidates are fused with lexical results;
if the provider is disabled, unavailable or times out, lexical search remains the
answer.

Claims and retries provide at-least-once processing. An expired lease or a lost
provider response can lead to another embedding request; there is no exactly-once
billing guarantee.

The vector scan is intentionally bounded to 1,000 rows per bot/model while the
JSON storage keeps the feature deployable without pgvector. A future migration can
move the verified vectors to pgvector without changing the tool or API contract.
