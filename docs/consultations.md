# Consultations between bots

A bot consults another through its `peer-N` remote agents
(`templates/bot/agent/lib/peers.ts`). The consulted bot answers read-only and one
hop deep. This page records the contracts that keep it that way.

## Who counts as a consultation

`isConsultation` (`templates/bot/agent/lib/caller.ts`) is the single
classification every guard uses: memory recall/write, the Drive snapshot and the
sandbox's `deny-all`, skills, routines, code tasks, `send_file`, history, Live
login, MCP and the one-hop rule. It recognizes two principals:

- `busy-hub:consultation:<fromBotId>:<toBotId>`: the hub-signed credential below.
- legacy: the asking bot's Vercel OIDC subject (`…:project:bot-<slug>:…`).

## What a consultation can't reach

A consultation must not send data to third parties (H-07):

- `web_fetch` is hidden and its `execute` rejects a consultation before any
  request leaves, including a call offered earlier or replayed through
  `eve__tool`.
- `find_skills` and `preview_skill` (query/id sent to skills.sh) and
  `install_skill` follow the same pattern.
- MCP connections are denied by default: no connection is resolved, and the
  approval policy denies every call, reads included, before the provider sees the
  arguments. An exception would need an explicit per-connection policy; none
  exists.
- Hub-backed memory and chat files stay available: answering the asking bot is
  the consultation's purpose.

Known gap: eve's `web_search` is a provider tool. eve 0.91 can't make it dynamic
or deferred, so it can't be hidden per session; a consultation can still send a
search query to the search provider (Exa through AI Gateway for Gateway models).
Closing it needs either eve support for a per-session provider-tool filter or a
product decision (drop `web_search`, or replace it with an authored, guardable
search tool).

## Consultation credential (H-26)

Before, the asking bot sent its own Vercel OIDC token to the peer, which could
replay it against the hub or other bots while it was valid. Now:

1. The asking bot calls `POST /api/bot/consultations/credential` with
   `{ "to": "<peer bot id>" }` (ids come from `/api/bot/directory`). The hub
   authenticates the caller with its Vercel OIDC token, checks that the target is
   a ready bot in the caller's current peer window and not the caller, and signs
   with `HUB_SIGNING_KEY`: `iss=busy-hub`,
   `sub=consultation:<fromId>:<toId>`, `aud=busy-consultation:<toSlug>`,
   `busy_purpose=consultation`, `from_bot`, `to_bot`, a `jti`, and a 5-minute
   expiry. The body never chooses issuer, subject or claims. The bearer is
   returned with `no-store`; it is not persisted or logged.
2. The bot passes it as eve's `auth` for that remote agent
   (`templates/bot/agent/lib/consultation-auth.ts`). eve calls `auth` before
   every request to the peer, so follow-ups, cancels and stream relays after a
   runtime rebuild get a fresh credential. A process cache reuses it until a
   minute before expiry; nothing goes into `ctx.memo`.
3. The consulted bot's eve channel accepts it with `jwtEcdsa` and
   `HUB_PUBLIC_KEY` only when `aud` is its own `busy-consultation:<slug>`, the
   subject is `consultation:*` and the purpose matches. A credential for B is
   refused by C, by B's hub verifier (`aud=<slug>`) and by the hub's `/api/bot/*`
   (Vercel OIDC issuer only).

### Rollout

The switches live in the bot project's environment and the hub sets neither yet.

1. Deploy the hub (issuer endpoint) and redeploy every bot with this template.
   Verifiers are always on when `HUB_PUBLIC_KEY` is set; bots still send OIDC.
2. When every bot runs the verifier, set `BUSY_CONSULTATION_CREDENTIALS=1` on
   the bot projects (and redeploy) so they send hub credentials. Check a
   consultation end to end.
3. Only then set `BUSY_LEGACY_PEER_OIDC=off` to retire the OIDC wildcard
   (`owner:<team>:project:bot-*:environment:production`). Until this step the
   old replay surface stays open.

Identity is still the verified slug (H-08). When bots get an immutable id from
OIDC, change the caller lookup in `apps/hub/lib/chat/consultation-credential.ts`
and version the audience in both `hub-token.ts` and `consultation-auth.ts`.

## Which bot was consulted (H-24, N-07)

The directory has one total order, `created_at` then `id`, in
`/api/bot/directory`, the hub's sync (`lib/chat/peer-binding.ts`) and the app's
initial data. `child.opened` still names only `peer-N`, so the sync binds each
consultation to a single candidate and asks it to confirm:

- the target recorded at dispatch: the child's admitted principal
  `busy-hub:consultation:<fromId>:<toId>`, read through the asking bot's subagent
  stream route and checked against the directory;
- for a legacy OIDC dispatch, only the bot the slot names now.

That candidate's deployment must answer the exact child session (2xx and
`x-eve-session-id`). Otherwise `to_bot_id` stays null with a `peer_unverified`
record; the sync never takes "the first bot that answers". At most 8
attributions per save batch within 10 s, never for a call already persisted, and
always before the events/cursor transaction. Child session ids must be eve run
ids (`wrun_` + 26-character ULID); anything else is neither probed nor stored.
With legacy credentials a slot that shifted before the sync leaves the
consultation unattributed.
