# MCP marketplace

Connections belong to the Busy app and are shared by all bots. Open **Skills, plugins and MCPs** beside the account menu or from app Settings, even before creating a bot. The centered modal groups **Skills**, **Plugins** and **MCPs**; select **MCPs** to search the catalog and choose **Connect with OAuth**. Public servers have an **Add** button. A connection becomes available only after authorization succeeds. Each bot chooses the connected tools relevant to the current task. **Disconnect** removes the app's stored grant for all bots.

## Registered provider setup

GitHub and the Google Workspace MCP servers use Busy's registered OAuth clients. Configure each provider once from the marketplace card before connecting the app. The setup form shows the client ID; the provider version is an internal API value. The client secret is accepted on save, encrypted by the hub, and never returned to the browser. A blank secret keeps the existing secret only when the client ID is unchanged. Changing the client ID or rotating the secret creates a new provider revision and marks that provider's existing app grants as needing reconnection; Busy does not silently drop a connection.

Use the exact callback URLs for the hub origin you control when registering the
clients. Set `HUB_URL` to that origin; never reuse a provider client for an
unregistered deployment:

- GitHub: `${HUB_URL}/api/mcp/oauth/github/callback`
- Google: `${HUB_URL}/api/mcp/oauth/google/callback`

Before changing `HUB_URL`, register the new GitHub and Google callback URLs with
their providers. Existing encrypted grants remain stored; no provider grant is
migrated or silently re-authorized. The optional Vercel login callback is
`${HUB_URL}/api/auth/vercel/callback`. The Vercel MCP CIMD document and callback
are `${HUB_URL}/.well-known/busy-mcp-client` and
`${HUB_URL}/api/mcp/oauth/vercel/callback`.

Busy derives the registered redirect URI from the canonical `HUB_URL`; it must be one configured hub origin. There is no alternate preview callback. If a separate deployment is intentionally registered, change that deployment's `HUB_URL` and register the exact resulting provider redirect before use; never reuse a production client for an unregistered origin. The callback URL must match exactly, including the path and scheme.

Google Workspace MCP is in Developer Preview. Enable the required APIs in a
project you control before connecting the catalog entry. If the consent screen
is configured as **Internal**, only users in that organization can authorize it;
accounts outside it need an approved external/test configuration and any required
provider review.

Changing a registered provider client invalidates Busy’s local app grants for that provider and requires reconnecting those services once. It does not revoke grants at GitHub or Google; revoke upstream access separately in the provider account when needed.

The catalog contains 21 apps: GitHub, Vercel, Gmail, Google Drive, Google Calendar, Google Docs, Google Sheets, Google Slides, Linear, Notion, Sentry, Atlassian, Neon, Todoist, Stripe, PayPal, Supabase, PostHog and Railway use OAuth; Context7 and DeepWiki are public. Vercel is grouped under **Developer tools** and uses its black symbol on the light icon tile. Endpoints are curated in `apps/hub/lib/mcp/catalog.ts`, with links to official documentation. Slack requires a separately managed connector; Figma still requires an approved client. Custom URLs, local/stdio servers and pasted API keys are outside this feature.

### Vercel MCP and CIMD

Vercel MCP is connected through OAuth Client ID Metadata Documents (CIMD), which Vercel currently accepts for unreviewed clients. Busy publishes a public metadata document at `/.well-known/busy-mcp-client`, derived from the configured `HUB_URL`, with the exact callback `/api/mcp/oauth/vercel/callback` and no client secret. The authorization server is discovered from Vercel's live MCP metadata; Busy does not perform dynamic client registration for this connection. The CIMD document must remain publicly reachable at the canonical hub origin and must not be generated from a forwarded `Host` header.

All app icons are self-hosted in `apps/hub/public/mcp-icons/`. Source URLs and asset provenance are recorded in `docs/mcp-icon-sources.json`; the marks come from Simple Icons or official provider assets. DeepWiki uses the Cognition mark from its official provider documentation. Icons use fixed dimensions and a light tile so brand colors and dark marks remain legible in Busy’s dark interface.

## Deployment

1. Apply `apps/hub/drizzle/0008_mcp_marketplace.sql`, `apps/hub/drizzle/0009_mcp_provider_clients.sql` and `apps/hub/drizzle/0013_app_mcp.sql` to the hub database before deploying the updated hub. The app migration removes bot ownership while preserving stored connection ids and encrypted grants.
2. Keep the existing `SESSION_SECRET` stable and at least 16 characters long. OAuth artifacts are encrypted with a domain-separated key derived from this secret; changing it requires reconnecting services. No new provider secret is required for catalog providers that support Dynamic Client Registration.
3. Deploy the updated hub and template. Bots created from the new template include the dynamic marketplace connection. Existing bot projects need one redeploy to receive that template code, including unique runtime names for any preserved duplicate service connections; preserve their `sessionId` as the existing deploy workflow does.
4. After this initial rollout, connecting or disconnecting services takes effect on the next model call without a bot redeploy or new chat session. An external request already in progress can finish.

On Busy Desktop, OAuth opens the same-origin connect route in the system browser so the complete flow uses one browser's cookies. If that browser has no Busy session, sign in there first; Busy returns to the connect route automatically. The desktop panel refreshes on focus and while consent is pending.

## Authorization and persistence

- The signed-in hub account manages connections at `/api/mcp`. Proxy authentication and the existing cross-site write check protect these routes.
- Connections have no bot foreign key. Deleting a bot leaves app connections and encrypted credentials intact. The migration preserves multiple grants for the same service; additional connections remain visible and removable, and each connected grant receives a distinct runtime name.
- The authenticated **Connect** POST issues a random, ten-minute, single-use intent ticket. The browser connect route consumes it under the row lock before starting OAuth, preventing arbitrary links from resetting a grant and supporting the system-browser login handoff.
- DCR-based MCPs use authorization-server discovery and Dynamic Client Registration; registered GitHub and Google MCPs use fixed provider endpoints and the configured provider client. Every flow uses PKCE, a random state, a ten-minute deadline, and a browser-bound `HttpOnly` cookie. State and verifier are consumed under a database row lock, including when consent is denied or a matching flow expires. SDK issuer validation receives the callback's `iss` parameter when present.
- AES-256-GCM encrypts tokens, registration metadata and pending flow data. Authentication binds ciphertext to the connection id. Browser-facing responses include only id, catalog id, status and a generic error.
- Remote discovery, where used, and all token/refresh requests use HTTPS/public-address validation at each redirect hop. Cross-origin POST redirects are rejected to avoid forwarding OAuth form credentials.
- Bots authenticate with their existing Vercel OIDC identity. `/api/bot/mcp` lists the app's connected services. `/api/bot/mcp/:id/token` authenticates the bot again and returns only an access token for a connected app service, with `Cache-Control: no-store`. Refresh tokens stay in the hub.
- Row locking serializes token refresh, callbacks, reconnects and disconnects. Expiring tokens are refreshed before use; providers that omit a replacement refresh token retain the previous one. A rejected grant requires reconnecting, while temporary failures retain the connection for retry.
- Eve's `agent/connections/marketplace.ts` rebuilds connections before every model call. Credentials are loaded lazily through `auth.getToken`; they never enter dynamic metadata, `ctx.memo`, conversation history or the catalog.

Disconnect removes Busy's copy of the grant. It does not call the provider's revocation API; grants can also be revoked from the provider's account settings.

### Duplicate grants

`mcp_connections` has no `UNIQUE(catalog_id)`, on purpose. `0013_app_mcp.sql` turned per-bot grants into app grants without merging them, so a database migrated from per-bot connections can hold several encrypted grants for one catalog id. `listConnections`, the runtime and provider-client rotation (`lib/mcp/provider-clients.ts`) therefore handle more than one row per catalog id.

New adds cannot create another duplicate: `addConnection` (`lib/mcp/store.ts`) is the only application insert, and it looks up and inserts inside one transaction that holds `pg_advisory_xact_lock(hashtext('busy:mcp:' || catalog_id))`. If a row exists, it returns the oldest one and changes nothing. `lib/mcp/store.test.ts` covers concurrent adds, untouched legacy duplicates and the single insert path; `lib/mcp/store.concurrency.test.ts` (opt-in with `BUSY_TEST_POSTGRES=1`) repeats the concurrent adds on a disposable PostgreSQL server with separate connections. Administrative SQL inserts are outside this guarantee.

Do not add a unique index or deduplicate automatically. A unique index first needs an inventory of every duplicate grant, an explicit keep/merge/reconnect decision for each, and a tested rollback; picking "the first" row would silently discard a user's authorization.

## Verification

The automated suite covers OAuth state/cookie validation and replay, expiry and denial, refresh-token rotation, encrypted persistence, safe projections, bot authentication, shared access, database constraints and persistence after bot deletion, dynamic runtime updates, and the marketplace UI. Tests use synthetic credentials; authorizing a real provider account remains a rollout check.

The production records below describe earlier releases with per-bot
connections. The app-wide migrations and updated template require a separate
rollout.

## Release verification

Run the focused MCP tests and the production build against your own isolated
database and provider registrations. Do not copy deployment IDs, storage state,
OAuth grants, or credentials from another environment.
