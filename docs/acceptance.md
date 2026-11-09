# Acceptance checklist

This document describes the checks that can be run by anyone who clones the
repository. It deliberately contains no production account names, deployment
IDs, cookies, credentials, or private hostnames.

## Bot identity

Each bot is identified by its stable database row and authenticated runtime
identity. A slug is a display and routing label; it is not an authorization
boundary. The hub must verify the bot's signed identity before accepting a
callback or reading bot-scoped data.

## One main session per bot

A bot has at most one active main session. Live view, chat sends, deploy refresh,
and routines open or replace that session through the shared session helper. A
caller that loses a concurrent open adopts the winner and the unused session is
ended. Session changes use compare-and-set semantics so a stale reader cannot
clear a newer session.

## Computer lifecycle

The bot image reports readiness before the hub exposes the desktop. Stop and
hold operations are bounded and must be safe to retry. A stop request must not
terminate a newer session or a process owned by another bot. Local image tests
exercise these paths without contacting a provider.

## Local acceptance run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint:next
pnpm typecheck
pnpm test -- --maxWorkers=2
pnpm build
```

For a self-hosted deployment, follow [the setup skill](../skills/busy-setup/SKILL.md)
and configure a new database and new provider credentials. Run the migrations
against that empty database only. Use synthetic credentials for tests and never
commit a local environment file.

## Evidence boundary

Production smoke results, provider account data, authenticated screenshots,
and deployment logs are environment-specific evidence. Re-run those checks in
your own account and keep the resulting files outside the repository.
