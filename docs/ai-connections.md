# AI connection and first-run setup

Busy shows **AI connection** in account Settings and asks for the same choice on
first entry. The hub stores the choice and onboarding completion in
`app_ai_settings`, a singleton for Busy's current single-account deployment.
It survives reloads, sign-outs and different devices. Dismissing the welcome
dialog does not complete setup; it can appear again on the next visit.

The available choices are:

| Connection | Current behavior |
| --- | --- |
| ChatGPT subscription | Connectable through OpenAI OAuth. Busy stores the encrypted grant, refreshes it server-side, and only exposes the account's advertised models. |
| Grok subscription | Connectable through xAI device-code OAuth. Busy uses xAI's subscription inference proxy and refreshes the encrypted grant server-side. |
| Vercel Token Pass | Selectable when the hub has `TOKEN_PASS_API_KEY`. New bots use the existing Token Pass deploy path. |
| AI Gateway | Selectable. New bots use the existing Gateway/OIDC deploy path and Gateway billing. |

Saving a connection sets the default **for new bots** and stores the selected
subscription model when applicable. It does not change,
redeploy or reset existing bots. Their model and billing remain editable in bot
Settings. Before any connection is saved, creation retains its legacy Token Pass
default if configured. If Token Pass is missing, creation asks the user to choose
another connection in Settings before running model selection or deployment.
Gateway and Token Pass creation use the existing AI Gateway Decision API.
Subscription creation uses the account model selected in Settings and never
makes a Gateway Decision request; see [Bot creation](./bot-creation.md).

The account menu and Settings summary follow the saved AI connection, including
its current connection status. Changing a radio in the unsaved form does not
change this summary. ChatGPT and Grok show their own identity and selected
model. They link to the provider's usage view instead of displaying
Token Pass credits as subscription usage. AI Gateway has its own summary;
Token Pass retains the existing Vercel usage report when selected.

OpenAI's [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
direct users to [ChatGPT usage settings](https://chatgpt.com/settings/usage).
Grok's [account dashboard](https://grok.com/dashboard), linked from its
[subscription management documentation](https://docs.x.ai/x-subscription/manage),
provides its Usage view. Busy does not invent an available balance or query
undocumented consumer endpoints to fill a quota widget.

`GET /api/ai/settings` returns only public connection metadata, the saved default
and onboarding state. `PUT /api/ai/settings` accepts only a supported, configured
connection, plus an account model for subscriptions, and completes onboarding
atomically with saving it. These routes use
the hub's existing authenticated session and cross-site-write checks. No
provider access or refresh tokens are accepted from or returned to the browser. If settings
cannot be read during bot creation, creation fails instead of silently choosing
another billing path.

Apply `apps/hub/drizzle/0015_ai_settings.sql` and then
`apps/hub/drizzle/0016_ai_subscriptions.sql` before running the updated hub. The
migrations are additive and repeatable, enable RLS and revoke browser-role privileges.
The hub's database connection owns all access, as with the other app-wide
settings tables. No external provider approval or production migration is
performed by adding this code.

## Subscription access constraints

Verified against provider documentation on **2026-11-02**:

- OpenAI documents [ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)
  with OAuth consent, PKCE, the `chatgpt.tokens.use.direct` scope, `store:false`
  and streaming Responses requests. Busy uses the account's model catalog and
  rejects unsupported state such as `previous_response_id`. Automatic OAuth
  uses a loopback callback in the local hub or Busy desktop. A remote browser
  without a local receiver cannot complete the OSS loopback flow; a separately
  registered hosted integration is a different contract. See [registration and
  sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
  and [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
- xAI publishes OAuth/OIDC discovery and the Grok Build authentication contract:
  [`auth.x.ai` discovery](https://auth.x.ai/.well-known/openid-configuration) and
  [Enterprise Deployments](https://docs.x.ai/build/enterprise). Busy uses the
  device-code flow with `grok-cli:access api:access`, validates the xAI account,
  and sends inference through `cli-chat-proxy.grok.com`; it does not treat an
  `XAI_API_KEY` as a subscription grant.

The earlier inference that separate API billing made Grok subscription OAuth
impossible was incorrect. [OpenCode](https://opencode.ai/docs/providers/#xai)
and Vercel Labs' [fx](https://fx.sh/docs/lib/providers) document subscription
connections for external agents. Grok's public OAuth client default follows
[libfx's implementation](https://github.com/vercel-labs/fx/blob/main/sdk/grok-sign-in.js);
`BUSY_GROK_CLIENT_ID` supports a separately registered client.

## Runtime and credential handling

`POST /api/ai/connections/<provider>` starts a short-lived sign-in. The
`/complete` route polls the owned ChatGPT authorization attempt or a Grok device grant.
Attempts are encrypted, expire, and are bound to the signed-in Busy user.
Completing OAuth discovers account models but does not change the saved default
until the user chooses a model and saves. `DELETE` disconnects a provider.

ChatGPT signs in using OpenAI's PKCE/state/nonce flow. Busy starts receiving the
loopback callback before opening authorization. In the local web app, the hub
serves `http://127.0.0.1:<hub-port>/auth/callback`. Busy desktop starts a temporary
listener on an available loopback port, opens the system browser, and forwards
the verified return to the hub using the existing Busy session. Only the hub
exchanges the authorization code. There is no URL field or manual finish step.
The original screen polls the attempt and updates automatically after approval.

Attempts retain a short-lived completion receipt, so duplicate callbacks and
polls cannot redeem an authorization code twice. State, PKCE, nonce, the exact
redirect URI and the issued client ID remain validated. Cancel invalidates the
owned attempt and closes the desktop listener. Local callbacks return a minimal
page with no provider credentials and close the authorization window when the
browser permits it.

The desktop forwards the callback to the hub origin named by `BUSY_URL`
(production by default). That variable is trusted operator configuration, not
user input: see [desktop.md](desktop.md#busy_url-is-trusted-configuration). A
desktop listener belongs to the page that started it: a renderer crash, restart
or navigation away from the hub cancels it, so a callback from before the
restart can't complete a newer attempt.

The default `dynamic_agent_client`
registration requests consent under Busy's name with a persisted host ID.
OpenAI controls client and account eligibility. An approved public registration
can be supplied using `BUSY_CHATGPT_CLIENT_ID`; this setting alone does not add
a hosted callback receiver. The implementation does not use
the Codex CLI's client identity or ChatGPT's `backend-api` endpoints.

The hub encrypts tokens with authenticated encryption and `SESSION_SECRET`,
with distinct per-provider/attempt associated data. Refreshes are serialized
with database row locks, including across server instances.

Deployed eve bots use an OpenAI Responses provider pointing at the hub's
`/api/bot/ai/responses` route. Each request is authenticated with the bot's
Vercel OIDC token. The hub checks the persisted bot provider and model, refreshes
the grant, and streams from the matching provider. Subscription tokens never
enter bot environment variables or deployment files.

Grok inference includes `x-grok-client-version: 1.0.13`, the proxy's supported
compatibility version verified on 2026-11-03. A valid grant and successful model
listing do not imply that inference will pass the proxy's version gate: omitting
this header returns HTTP 426. Recheck this version if xAI raises its minimum.

Subscription runtimes keep response metadata under separate ChatGPT and Grok
namespaces. A later turn only replays item IDs and encrypted reasoning from its
current provider. Switching providers keeps the visible conversation and client
tool definitions without reusing another provider's opaque response state.

OAuth and upstream calls are covered by mocked tests; these do not prove that
a particular user or registration has completed consent or has subscription
allowance. A connection is marked connected only after the provider grants
access and its account model catalog is returned successfully.

OAuth grants and API keys remain separate connection contracts. Provider sign-in,
renewal, revocation, model restrictions, runtime routing and usage-limit handling
must all work before a subscription is marked connected. There is no fallback
from a subscription connection to paid Gateway usage.

## Subscription first-token latency

Subscription runtimes derive `prompt_cache_key` from a SHA-256 hash of the provider
and Eve session ID. The key stays stable across turns and changes for another
session or provider. The Responses proxy preserves it instead of dropping it from
the request allowlist. Already-deployed runtimes that omit the key receive a
fallback derived from the bot's persisted root session, so those chats benefit
from the Hub update without a bot redeployment. Updated runtimes also distinguish
delegated and consultation sessions.

This is prompt-prefix reuse, not response caching. The complete conversation is
still sent, `store:false` remains enforced, and provider replay metadata stays
isolated. xAI documents the key's role in routing requests to the same cache
server in [Maximizing Cache Hits](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits).
Cache hits and latency improvements remain provider-dependent.

Valid OAuth grants use one fresh database read without a transaction or row lock.
Only grants that need renewal enter the existing locking transaction, which
re-reads the row before refreshing so concurrent calls cannot rotate the same
refresh token twice. Credentials are not cached between requests.

Production measurements on November 4, 2026 found approximately 60,000 input
tokens but only 1,152 cached tokens on two short responses. Browser TTFT was
7.82 s and 6.60 s. A separate traced request reached the provider 0.53 s after
entering the Hub and completed after 5.06 s. These are baselines before this
cache-affinity and credential-read change; they do not establish the improvement
of the patched deployment. Verify cache-read tokens and first-text latency over
repeated messages on the same model and conversation after release. Temporary
trace sampling used for the investigation was restored to its prior disabled
state.

## Exception behavior

Busy keeps the bot's saved billing path when an inference request fails. A
ChatGPT or Grok subscription failure never silently becomes an AI Gateway or
Token Pass request, and a Token Pass or Gateway allowance failure never spends
from another connection. The hub turns provider responses into a small,
provider-aware error contract before the event reaches a bot or the browser;
provider response bodies, access tokens and request diagnostics are not shown
in chat, routine history or bot status.

The user-facing recovery depends on the failure:

- An expired or revoked ChatGPT/Grok grant asks the user to reconnect
  that provider in Settings. A temporary provider or network outage keeps the
  grant and can be retried with bounded backoff. A terminal refresh failure
  removes the stale connection metadata. An upstream authentication rejection
  invalidates only the exact grant used by that request, preserving a
  concurrent reconnection or refresh.
- A permission or plan-eligibility rejection asks the user to review account
  access or choose a supported connection; it is distinct from a lost Busy
  login.
- A provider usage limit or Token Pass allowance issue points to the provider's
  usage view or to another connection. It does not claim a reset time that Busy
  cannot verify.
- A rate limit says to try again later. An unsupported model or request points
  to bot Settings or asks the user to edit the message. These cases are not
  retried indefinitely.
- Bot creation and edits preserve the current form selection when a request
  fails. A saved account connection applies only to new bots; existing bots
  continue using their own billing and model until the user changes them.

| Flow | Failure and recovery |
| --- | --- |
| First entry and AI settings | Failed loading has Retry; failed saves retain the draft. Cancelling OAuth does not complete onboarding. Expired attempts, refused access and a blocked provider window have distinct guidance. |
| Account and usage | The saved connection owns the status and usage link. An unconfigured Token Pass does not show an allowance. Busy does not invent a subscription balance. |
| Create, edit and deploy | The form retains identity and model choices. Unavailable connections and models point to the appropriate settings. Deployment failures use fixed messages. |
| Send a message | Network/server retries keep the original message id, file references and browser context. Validation, authorization and rate-limit failures are not immediately replayed. Explicit Retry preserves the delivery idempotency key. |
| Reply and stream | Provider failures show reconnection, usage, waiting or model guidance. Ordinary tool failures keep generic task guidance. Raw provider errors are removed from persisted and streamed model facts. |
| Bot consultations | The responding bot supplies the provider identity. Failed thread loading offers a read-only retry; it does not resend the consultation. |
| Computer wake and browser login | The internal wake prompt stays hidden, but its model failure can show recovery in chat. Browser login/control and file-upload errors keep their independent recovery flows. |
| Routines | The latest run displays its result and safe failure guidance. Model failures correlate to the same turn. A failed task is not automatically rerun, and acceptance alone is not success. |

The provider-specific recovery references are [OpenAI's ChatGPT plan error and
recovery guide](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery),
[xAI's debugging guide](https://docs.x.ai/developers/debugging), and [xAI's rate
limits](https://docs.x.ai/developers/rate-limits). For Gateway, [Vercel's budget
guide](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets)
defines budget exhaustion (`402`) separately from [rate limits and free-tier
pricing](https://vercel.com/docs/ai-gateway/pricing) (`429`).

The exception copy is covered by mocked routes and event fixtures. Real
provider authorization, plan eligibility, quota behavior and a deployed bot
template still need an acceptance run with disposable ChatGPT, Grok, Token Pass
and Gateway connections before production rollout. This work does not perform
that deployment or change any existing bot's billing.
