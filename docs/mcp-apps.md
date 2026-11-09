# MCP Apps in Busy

Busy renders interfaces supplied by connected MCP servers inside the chat. This
uses the MCP Apps extension, not a provider-specific deployment card. Vercel's
`open_deployments` is one example; other connected servers can provide their own
interfaces through the same protocol.

## Protocol and permissions

- Discovery negotiates `io.modelcontextprotocol/ui` and retains each tool's
  `_meta.ui.resourceUri` and visibility. The legacy `ui/resourceUri` key is also
  recognized. Only `ui://` resources with `text/html;profile=mcp-app` are rendered.
- Tools marked only `app` are available to the interface, subject to the
  connection's reviewed permissions, and are excluded from the model's tools.
- The browser identifies the original tool call. The hub resolves its connection,
  input and result from the bot's stored session; the browser cannot select an
  arbitrary server or resource URL.
- Every app action rechecks the current connection and tool permissions. Revoking
  a connection or tool takes effect on the next request from an already open app.
- Read-only tools can refresh data. Other tools require confirmation displaying
  the requested action and arguments. Sending app text into the chat also
  requires confirmation and uses the ordinary user-message flow.
- MCP OAuth tokens stay on the server. App resources and tool responses are
  private, uncached HTTP responses.

## Rendering

The chat uses the official MCP Apps `AppBridge` with its postMessage transport.
Busy keeps its existing Eve chat store and streaming protocol. Normal MCP tools
continue to render as ordinary chat activity. App launch results are sealed in
`mcp_app_results`; Eve receives only model-visible content and an opaque snapshot
reference. Private result metadata is recovered by the authenticated host.

The sandbox proxy and the main application must use different origins. The proxy
creates an inner iframe without `allow-same-origin`, applies a restrictive CSP,
and forwards JSON-RPC messages between that iframe and the Busy host. The app
cannot access Busy cookies, DOM or storage. Browser capabilities such as camera,
microphone and geolocation are denied by default.

The app can request fullscreen without remounting its iframe, so its current
view and refresh state survive the transition. External links use a separate
window with opener access disabled.

## Setup

Apply `apps/hub/drizzle/0022_mcp_app_results.sql` before enabling app launches.
The table has RLS enabled and no browser-role grants. Its sealed payloads use
the existing `SESSION_SECRET`, with separate snapshot-bound authenticated data.

Configure the canonical host and a distinct sandbox origin:

```env
HUB_URL=https://busy.example.com
MCP_APP_SANDBOX_ORIGIN=https://sandbox.example.com
```

The sandbox origin must serve `/mcp-app-sandbox` from the same Busy version. It
can be a second domain on the same deployment, provided that route is public
and deployment protection does not block iframe requests. The route accepts
only the configured host as its parent. Missing or same-origin production
configuration fails closed. Do not point the sandbox at the chat origin.

For local development, the default pair is `http://localhost:3000` for the chat
and `http://127.0.0.1:3000` for the sandbox. Set `HUB_URL` when using another
port. No second local process is necessary.

Existing connections need a tool refresh to discover their app metadata. Review
the tools allowed to the app in the marketplace. Vercel is available there with
CIMD OAuth; it requires its own authorization by the user. The coding-task
widget and deployment app remain separate views in the same chat.

## References

- [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [AI SDK MCP Apps host guide](https://vercel.com/kb/guide/ai-sdk-mcp-apps)
- [Vercel deployment app announcement](https://vercel.com/changelog/monitor-vercel-deployments-in-chatgpt)
- [Vercel MCP authentication](https://vercel.com/docs/agent-resources/vercel-mcp)

Busy pins the bridge package version. Upgrades must rerun the protocol, browser
and sandbox regression checks.
