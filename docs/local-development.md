# Local connections to your deployed bots

The local hub reads the shared database, but that alone does not authenticate a message to a bot. The signing key remains on the deployed hub. Pulling development variables intentionally does not download it.

Refresh the development environment through the Vercel project linked to your hub:

```sh
cd apps/hub
vercel env pull .env.local --environment=development --yes
```

Local connections use `DEV_RELAY_URL`, pointing to your deployed hub, and the refreshed `VERCEL_OIDC_TOKEN`. Your bot and Live relays share a registered development grant:

- `DEV_RELAY=1` explicitly enables the grant.
- `DEV_RELAY_UNTIL` must be a future ISO timestamp, bounded by the development token's expiry.
- `DEV_RELAY_TOKEN_SHA256` is the SHA-256 fingerprint of that exact development bearer token, never the token itself.

The relay validates the token's Vercel signature, expiry, configured team and the fixed `busy-hub` project subject used by the hub/bot protocol. `busy-hub` is the protocol issuer; the Vercel team is your `VERCEL_TEAM_SLUG`. Another team member's otherwise-valid hub token does not match the registered fingerprint. Missing or expired configuration closes the relay with 404; missing, mismatched or invalid credentials return 401. Project environment changes require a hub redeployment to take effect.

When a development token is renewed, its fingerprint and grant expiry must also be renewed on your hub. Keep the `.env.local` file private and restart the local dev server after refreshing it. Do not print bearer tokens or pull the deployed signing key as a workaround.

The local hub reads the shared database, but its `SESSION_SECRET` is intentionally different from any deployed environment. OAuth subscription grants are encrypted with that secret, so a grant connected from localhost cannot be read by a deployed hub. Connect providers from the `HUB_URL` environment you intend to use; do not overwrite a deployed grant from localhost or change the deployed secret to make a local grant readable.

For a connection check, read the existing session stream or the authenticated agent-info route. Do not create a real routine merely to test connectivity. Existing bots need the current template deployed before their info exposes `manage_routines`; updating the hub alone does not change a bot's tools.
