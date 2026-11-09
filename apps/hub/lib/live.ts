import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getVercelOidcToken } from "@vercel/oidc";
import { APIError, Sandbox } from "@vercel/sandbox";
import { and, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getBot } from "./bots/service";
import { sessionBusy, sessionTurn } from "./chat/open-turn";
import { syncBot } from "./chat/store";
import { type BotRow, botComputers, bots, db } from "./db";
import { need } from "./env";
import {
  observeOperation,
  operationErrorCode,
} from "./operation-observability";
import { sandboxName } from "./sandbox-name";
import { projectId } from "./vercel/client";

// The live screen (Grok Bot's "Watch" / "Take control"): the app's noVNC talks to x11vnc
// in the bot's computer through websockify on this port (images/bot-base/desktop-live.sh).
export const LIVE_PORT = 6080;
/** After the hub asked the bot to boot its computer (WAKE_MESSAGE), how long to wait for it to exist. */
export const NEW_COMPUTER_WAIT_MS = 90_000;
/** A viewer counts as watching this long after its last heartbeat (the app beats every 30 s). */
export const WATCH_MS = 90_000;
/** Opening a bot's chat or writing to it keeps its computer on this long, so Live is up when tapped. */
export const KEEP_ON_MS = 10 * 60_000;

export type LiveMode = "observe" | "control";
export interface Live {
  /**
   * Whether the managed Chrome was ready when the screen was shared. "busy": the screen is shared, but an
   * agent action or a viewer held desktop-control, so browser actions still answer CONTROL_BUSY. Missing
   * on images whose desktop-live does not report it. A shared screen never means the browser is usable.
   */
  browser?: LiveBrowser;
  password: string;
  url: string;
  viewOnly: boolean;
}
export type LiveBrowser = "ready" | "busy";

/** The browser state desktop-live prints as its last stdout line; undefined when it reports none. */
export function liveBrowserState(stdout: string): LiveBrowser | undefined {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const value = JSON.parse(last) as { browser?: unknown; ok?: unknown };
    return value.ok === true &&
      (value.browser === "ready" || value.browser === "busy")
      ? value.browser
      : undefined;
  } catch {
    return undefined;
  }
}
export type ControlAction = "acquire" | "renew" | "release";
export type ControlResult =
  | { ok: true; expiresAt?: number }
  | {
      ok: false;
      error: string;
      code: "CONTROL_BUSY" | "CONTROL_LOST" | "CONTROL_UNAVAILABLE";
    };

/**
 * Per-computer secrets, derived instead of stored: websockify's token and x11vnc's two passwords
 * (VNC keeps 8 characters). The view password only watches; x11vnc enforces it, not the app.
 */
export function liveSecrets(name: string, secret: string) {
  const mac = (purpose: string) =>
    createHmac("sha256", secret)
      .update(`${purpose}:${name}`)
      .digest("base64url");
  return {
    control: mac("live-control").slice(0, 8),
    token: mac("live-token"),
    view: mac("live-view").slice(0, 8),
  };
}

/**
 * Local dev has no VERCEL_TOKEN: like bot calls (lib/chat/store.ts), it goes through the deployed hub's
 * dev relay (app/api/dev/live), which checks our pulled busy-hub OIDC token. Null outside local dev.
 */
async function viaDevRelay(
  bot: BotRow,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown
): Promise<Response | null> {
  const relay = process.env.DEV_RELAY_URL;
  if (!relay) {
    return null;
  }
  const res = await fetch(`${relay}/api/dev/live/${bot.slug}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${await getVercelOidcToken()}`,
      "Content-Type": "application/json",
    },
    method,
  });
  if (!res.ok && res.status !== 409 && res.status !== 503) {
    throw new Error(`dev live relay failed: ${res.status}`);
  }
  return res;
}

/** The bot's own Vercel project: a sandbox of another bot or team is never found through it. */
async function botCredentials(
  bot: Pick<BotRow, "slug"> & { vercelProjectId?: string | null }
) {
  const cfg = { teamId: need("VERCEL_TEAM_ID"), token: need("VERCEL_TOKEN") };
  return {
    // The project the bot's identity is bound to (0028); the name only for rows not linked yet.
    projectId: bot.vercelProjectId ?? (await projectId(cfg, `bot-${bot.slug}`)),
    teamId: cfg.teamId,
    token: cfg.token,
  };
}

/**
 * The session's sandbox name (H-18): the one the bot reported for this exact session, else eve
 * 0.91's derived name (sessions from before the report, or a bot on an older template).
 */
export async function computerName(
  bot: Pick<BotRow, "id">,
  sessionId: string
): Promise<{ name: string; source: "derived" | "reported" }> {
  const [row] = await db()
    .select({
      name: botComputers.sandboxName,
      sessionId: botComputers.sandboxSessionId,
    })
    .from(botComputers)
    .where(eq(botComputers.botId, bot.id));
  if (row?.name && row.sessionId === sessionId) {
    return { name: row.name, source: "reported" };
  }
  return { name: sandboxName(sessionId), source: "derived" };
}

/** The bot's computer, through its project (bots live in their own). Null when the session never opened one. */
export async function computer(
  bot: BotRow,
  waitMs = 0,
  pollMs = 2500
): Promise<{ sandbox: Sandbox; name: string } | null> {
  if (!bot.sessionId) {
    return null;
  }
  const { name } = await computerName(bot, bot.sessionId);
  const credentials = await botCredentials(bot);
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Sandbox lookup retries are intentionally sequential and bounded.
      return { name, sandbox: await Sandbox.get({ name, ...credentials }) };
    } catch (error) {
      if (!(error instanceof APIError && error.response.status === 404)) {
        throw error;
      }
      if (Date.now() >= until) {
        return null;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

/**
 * desktop-live, then up to 5 s for x11vnc (5900) and websockify to accept: both start in the background,
 * and a viewer that connects first gets websockify's "Failed to connect to downstream server".
 * Before it, for new passwords and only on images without /etc/busy-image-version: images up to
 * bot-base:v5 pkill the old x11vnc and don't wait for it to exit, so they start none. Newer images
 * rotate only the x11vnc they recorded themselves (images/bot-base/desktop-live.sh) and exit 75 while
 * it is still stopping, which reaches the caller as a retryable failure.
 * The secrets go in as arguments, never into the script. A screen still not up after that is the viewer's error.
 */
export const START_LIVE = `if [ ! -e /etc/busy-image-version ] && [ "$(cat /tmp/desktop-runtime/live/passwords 2>/dev/null)" != "$2 $3" ]; then
  pkill -x x11vnc
  for _ in $(seq 50); do pgrep -x x11vnc >/dev/null || break; sleep 0.1; done
fi
desktop-live "$@" || exit $?
for _ in $(seq 50); do
  (exec 3<>/dev/tcp/127.0.0.1/5900 && exec 4<>/dev/tcp/127.0.0.1/${LIVE_PORT}) 2>/dev/null && exit 0
  sleep 0.1
done
exit 1`;

/**
 * Wakes the computer if it sleeps, starts the live screen and exposes it. Idempotent: the app calls it
 * again to switch modes. Null when the bot has no computer yet.
 */
export async function openLive(
  bot: BotRow,
  mode: LiveMode,
  waitMs = 0,
  requestId: string = randomUUID()
): Promise<Live | null> {
  const startedAt = performance.now();
  observeOperation({
    botId: bot.id,
    entryPoint: "http",
    flow: "live",
    operationId: requestId,
    outcome: "started",
    requestId,
    sessionId: bot.sessionId,
    stage: "session",
  });
  try {
    const relayed = await viaDevRelay(bot, "POST", { mode, waitMs });
    if (relayed) {
      const live =
        relayed.status === 409 ? null : ((await relayed.json()) as Live);
      observeOperation({
        botId: bot.id,
        durationMs: performance.now() - startedAt,
        entryPoint: "http",
        flow: "live",
        operationId: requestId,
        outcome: live ? "completed" : "pending",
        requestId,
        sessionId: bot.sessionId,
        stage: "session",
      });
      return live;
    }
    const live = await openLiveInSandbox(bot, mode, waitMs);
    observeOperation({
      botId: bot.id,
      durationMs: performance.now() - startedAt,
      entryPoint: "http",
      flow: "live",
      operationId: requestId,
      outcome: live ? "completed" : "pending",
      requestId,
      sessionId: bot.sessionId,
      stage: "session",
    });
    return live;
  } catch (error) {
    observeOperation({
      botId: bot.id,
      durationMs: performance.now() - startedAt,
      entryPoint: "http",
      errorCode: operationErrorCode(error),
      flow: "live",
      operationId: requestId,
      outcome: "failed",
      requestId,
      sessionId: bot.sessionId,
      stage: "session",
    });
    throw error;
  }
}

export async function openLiveInSandbox(
  bot: BotRow,
  mode: LiveMode,
  waitMs = 0
): Promise<Live | null> {
  // A shutdown already sent to the provider isn't undone by this open: let it finish, then resume.
  await stopSettled(bot.id);
  const found = await computer(bot, waitMs);
  if (!found) {
    return null;
  }
  const { sandbox, name } = found;
  const s = liveSecrets(name, need("SESSION_SECRET"));
  // A stopped (persistent) sandbox resumes on this first call.
  const run = await sandbox.runCommand({
    args: ["-c", START_LIVE, "desktop-live", s.token, s.control, s.view],
    cmd: "bash",
  });
  if (run.exitCode !== 0) {
    throw new Error(
      `desktop-live failed (${run.exitCode}): ${(await run.stderr()).slice(0, 300)}`
    );
  }
  if (!sandbox.routes.some((r) => r.port === LIVE_PORT)) {
    await sandbox.update({ ports: [LIVE_PORT] });
  }
  const url = new URL(sandbox.domain(LIVE_PORT));
  url.protocol = "wss:";
  url.searchParams.set("token", s.token);
  const browser = liveBrowserState(await run.stdout());
  return {
    ...(browser ? { browser } : {}),
    password: mode === "control" ? s.control : s.view,
    url: url.toString(),
    viewOnly: mode === "observe",
  };
}

function controlUnavailable(message: string): ControlResult {
  return { code: "CONTROL_UNAVAILABLE", error: message, ok: false };
}

function parseControlResult(stdout: string, fallback: string): ControlResult {
  const text = stdout.trim();
  if (!text) {
    return controlUnavailable(fallback);
  }
  try {
    const lastLine = text.split("\n").at(-1);
    if (!lastLine) {
      return controlUnavailable(fallback);
    }
    const value = JSON.parse(lastLine) as Partial<ControlResult>;
    if (
      value.ok === true &&
      (value.expiresAt === undefined || typeof value.expiresAt === "number")
    ) {
      return typeof value.expiresAt === "number"
        ? { expiresAt: value.expiresAt, ok: true }
        : { ok: true };
    }
    if (
      value.ok === false &&
      typeof value.error === "string" &&
      (value.code === "CONTROL_BUSY" || value.code === "CONTROL_LOST")
    ) {
      return { code: value.code, error: value.error, ok: false };
    }
  } catch {
    // The image may predate desktop-control and print a shell error instead of JSON.
  }
  return controlUnavailable(text.slice(0, 300) || fallback);
}

/** Runs the VM's lease helper without waking a stopped sandbox. */
export async function desktopControlInSandbox(
  bot: BotRow,
  action: ControlAction,
  viewerId: string
): Promise<ControlResult> {
  const found = await computer(bot);
  if (!found) {
    return {
      code: "CONTROL_LOST",
      error: "The computer is not running. Open Live again to retry.",
      ok: false,
    };
  }
  if (found.sandbox.status !== "running") {
    return {
      code: "CONTROL_LOST",
      error: "The computer is not running. Open Live again to retry.",
      ok: false,
    };
  }
  try {
    const run = await found.sandbox.runCommand({
      args: [action, viewerId],
      cmd: "desktop-control",
    });
    const stdout = await run.stdout();
    if (run.exitCode === 0) {
      return parseControlResult(
        stdout,
        "The computer did not return a control lease."
      );
    }
    const stderr = await run.stderr();
    const parsed = parseControlResult(
      stdout,
      stderr || "The computer rejected control."
    );
    return parsed.ok
      ? {
          code: "CONTROL_UNAVAILABLE",
          error: stderr || "The computer rejected control.",
          ok: false,
        }
      : parsed;
  } catch (error) {
    return controlUnavailable(
      error instanceof Error
        ? error.message.slice(0, 300)
        : "The control helper is unavailable in this image."
    );
  }
}

/** Acquires, renews, or releases the current component's exclusive VM input lease. */
export async function desktopControl(
  bot: BotRow,
  action: ControlAction,
  viewerId: string,
  requestId: string = randomUUID()
): Promise<ControlResult> {
  const startedAt = performance.now();
  try {
    const relayed = await viaDevRelay(bot, "PATCH", { action, viewerId });
    if (relayed) {
      const body = (await relayed
        .json()
        .catch(() => null)) as ControlResult | null;
      const result =
        body ?? controlUnavailable("The control relay returned no result.");
      observeOperation({
        botId: bot.id,
        durationMs: performance.now() - startedAt,
        entryPoint: "http",
        flow: "live",
        operationId: requestId,
        outcome: result.ok ? "completed" : "rejected",
        requestId,
        stage: "tool",
      });
      return result;
    }
    const result = await desktopControlInSandbox(bot, action, viewerId);
    observeOperation({
      botId: bot.id,
      durationMs: performance.now() - startedAt,
      entryPoint: "http",
      flow: "live",
      operationId: requestId,
      outcome: result.ok ? "completed" : "rejected",
      requestId,
      stage: "tool",
    });
    return result;
  } catch (error) {
    observeOperation({
      botId: bot.id,
      durationMs: performance.now() - startedAt,
      entryPoint: "http",
      errorCode: operationErrorCode(error),
      flow: "live",
      operationId: requestId,
      outcome: "failed",
      requestId,
      stage: "tool",
    });
    throw error;
  }
}

const interval = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

/** Advances the computer's generation: any shutdown claimed at an older one can't commit. */
async function advanceGeneration(
  q: Pick<ReturnType<typeof db>, "insert">,
  botId: string,
  set: Partial<typeof botComputers.$inferInsert> = {}
): Promise<void> {
  await q
    .insert(botComputers)
    .values({ botId, generation: 1, ...set })
    .onConflictDoUpdate({
      set: { generation: sql`${botComputers.generation} + 1`, ...set },
      target: botComputers.botId,
    });
}

/**
 * Keeps the computer on for `ms` more, never shortening what it already had (a heartbeat inside a
 * chat's 10 minutes), and advances its generation in the same transaction (H-16). A shutdown
 * committed first is serialized before it: opening Live waits for that stop, then resumes.
 */
export async function markWatching(
  botId: string,
  ms = WATCH_MS
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .update(bots)
      .set({
        liveUntil: sql`greatest(${bots.liveUntil}, now() + ${interval(ms)})`,
      })
      .where(eq(bots.id, botId));
    await advanceGeneration(tx, botId);
  });
}

/** A claim older than this belongs to a watcher or hook that died: it can be taken over. */
export const CLAIM_STALE_MS = 2 * 60_000;
/** How long opening Live waits for a committed shutdown to finish before resuming the computer. */
export const STOP_SETTLE_MS = 30_000;
/** request_login's longest hold on the computer while the user logs in. */
export const LOGIN_HOLD_MS = 2 * 60 * 60_000;
/** A held computer gets more time once it has less than this left, */
const HOLD_MARGIN_MS = 15 * 60_000;
/** and this much at a time, never past the hold's end. */
const HOLD_STEP_MS = 30 * 60_000;

export interface ShutdownClaim {
  claim: string;
  generation: number;
  sessionId: string;
}

// A login hold on this session keeps it: neither the watcher nor the hook may stop it.
const notHeld = (sessionId: string) =>
  sql`not coalesce(${botComputers.holdSessionId} = ${sessionId} and ${botComputers.holdUntil} > now(), false)`;
// The lease is over: no viewer, no recent chat.
const leaseOver = () =>
  or(isNull(bots.liveUntil), lte(bots.liveUntil, sql`now()`));

/**
 * The one permission to stop this session's computer (H-16/H-17): only while it is still the
 * bot's session, its lease is over, no login holds it and no other live claim exists. Null when
 * any of that fails. The claim is bound to the generation it saw and to the session.
 */
export async function claimShutdown(
  botId: string,
  sessionId: string
): Promise<ShutdownClaim | null> {
  const claim = randomUUID();
  await db().insert(botComputers).values({ botId }).onConflictDoNothing();
  const [won] = await db()
    .update(botComputers)
    .set({
      claim,
      claimAt: sql`now()`,
      claimPhase: "checking",
      claimSessionId: sessionId,
    })
    .from(bots)
    .where(
      and(
        eq(botComputers.botId, botId),
        eq(bots.id, botComputers.botId),
        eq(bots.sessionId, sessionId),
        leaseOver(),
        or(
          isNull(botComputers.claim),
          lt(botComputers.claimAt, sql`now() - ${interval(CLAIM_STALE_MS)}`)
        ),
        notHeld(sessionId)
      )
    )
    .returning({ generation: botComputers.generation });
  return won ? { claim, generation: won.generation, sessionId } : null;
}

/**
 * Re-checks a claim at its generation and session, and refreshes it. `stopping` commits it: from
 * then on a heartbeat is serialized after the stop instead of preventing it. False when anything
 * moved (a heartbeat, Live, a delivery's keep-on, a login hold, a new session): don't stop.
 */
export async function confirmShutdown(
  botId: string,
  { claim, generation, sessionId }: ShutdownClaim,
  phase: "checking" | "stopping"
): Promise<boolean> {
  const confirmed = await db()
    .update(botComputers)
    .set({ claimAt: sql`now()`, claimPhase: phase })
    .from(bots)
    .where(
      and(
        eq(botComputers.botId, botId),
        eq(bots.id, botComputers.botId),
        eq(botComputers.claim, claim),
        eq(botComputers.claimSessionId, sessionId),
        eq(botComputers.generation, generation),
        eq(bots.sessionId, sessionId),
        leaseOver(),
        notHeld(sessionId)
      )
    )
    .returning({ botId: botComputers.botId });
  return confirmed.length > 0;
}

/** Drops a claim only if it is still this one. */
export async function releaseShutdown(
  botId: string,
  claim: string
): Promise<void> {
  await db()
    .update(botComputers)
    .set({ claim: null, claimAt: null, claimPhase: null, claimSessionId: null })
    .where(and(eq(botComputers.botId, botId), eq(botComputers.claim, claim)));
}

/** Waits (bounded) while a committed shutdown is still in flight, so an open resumes after it. */
async function stopSettled(
  botId: string,
  waitMs = STOP_SETTLE_MS,
  pollMs = 500
): Promise<void> {
  const until = Date.now() + waitMs;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling one row until the stop settles, bounded.
    const [row] = await db()
      .select({ botId: botComputers.botId })
      .from(botComputers)
      .where(
        and(
          eq(botComputers.botId, botId),
          eq(botComputers.claimPhase, "stopping"),
          gt(botComputers.claimAt, sql`now() - ${interval(CLAIM_STALE_MS)}`)
        )
      );
    if (!row) {
      return;
    }
    if (Date.now() >= until) {
      console.warn("live: opening while a shutdown is still in flight", {
        botId,
      });
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * request_login's hold (H-17): keeps this session's computer for at most LOGIN_HOLD_MS while the user
 * logs in. Refused for a session that isn't the bot's current one. Returns the hold's end.
 */
export async function holdComputer(
  bot: Pick<BotRow, "id" | "sessionId">,
  sessionId: string
): Promise<Date | null> {
  if (bot.sessionId !== sessionId) {
    return null;
  }
  const holdUntil = new Date(Date.now() + LOGIN_HOLD_MS);
  await advanceGeneration(db(), bot.id, {
    holdSessionId: sessionId,
    holdUntil,
  });
  return holdUntil;
}

/** Ends this session's login hold (the user answered, or the turn withdrew the question). */
export async function releaseHold(
  botId: string,
  sessionId: string
): Promise<void> {
  await db()
    .update(botComputers)
    .set({ holdSessionId: null, holdUntil: null })
    .where(
      and(
        eq(botComputers.botId, botId),
        eq(botComputers.holdSessionId, sessionId)
      )
    );
}

/** This session's login hold, while it lasts. */
export async function activeHold(
  botId: string,
  sessionId: string
): Promise<Date | null> {
  const [row] = await db()
    .select({ holdUntil: botComputers.holdUntil })
    .from(botComputers)
    .where(
      and(
        eq(botComputers.botId, botId),
        eq(botComputers.holdSessionId, sessionId),
        gt(botComputers.holdUntil, sql`now()`)
      )
    );
  return row?.holdUntil ?? null;
}

/**
 * Gives a held, running computer more time with the Sandbox SDK's own `extendTimeout`, never past
 * the hold's end; a stopped one is never woken. Without this the image's 45-minute timeout ends a
 * login that takes longer; when the hold ends or this fails, that timeout still bounds it.
 */
export async function extendHeldComputer(
  bot: BotRow,
  holdUntil: Date,
  signal: AbortSignal = AbortSignal.timeout(10_000)
): Promise<number> {
  const found = await computer(bot);
  if (found?.sandbox.status !== "running") {
    return 0;
  }
  const expiresAt = found.sandbox.expiresAt?.getTime();
  if (expiresAt === undefined || expiresAt - Date.now() > HOLD_MARGIN_MS) {
    return 0;
  }
  const ms = Math.min(HOLD_STEP_MS, holdUntil.getTime() - expiresAt);
  if (ms <= 0) {
    return 0;
  }
  await found.sandbox.extendTimeout(ms, { signal });
  return ms;
}

const SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * The bot reports its session's real sandbox name (H-18). Stored only for the bot's current
 * session and only if that sandbox exists in the bot's own project (the credentials are scoped to
 * `bot-<slug>`, so another bot's or team's sandbox isn't found).
 */
export async function reportSandbox(
  bot: BotRow,
  sessionId: string,
  name: string
): Promise<"invalid" | "missing" | "session" | "stored"> {
  if (!SANDBOX_NAME.test(name)) {
    return "invalid";
  }
  if (bot.sessionId !== sessionId) {
    return "session";
  }
  try {
    await Sandbox.get({ name, ...(await botCredentials(bot)) });
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) {
      return "missing";
    }
    throw error;
  }
  await db()
    .insert(botComputers)
    .values({ botId: bot.id })
    .onConflictDoNothing();
  const stored = await db()
    .update(botComputers)
    .set({
      sandboxName: name,
      sandboxReportedAt: sql`now()`,
      sandboxSessionId: sessionId,
    })
    .from(bots)
    .where(
      and(
        eq(botComputers.botId, bot.id),
        eq(bots.id, botComputers.botId),
        eq(bots.sessionId, sessionId)
      )
    )
    .returning({ botId: botComputers.botId });
  if (!stored.length) {
    return "session";
  }
  if (name !== sandboxName(sessionId)) {
    // eve's private naming changed: the reported name wins; lib/live.ts's fallback needs an update.
    console.warn("live: reported sandbox name differs from the derived one", {
      botId: bot.id,
      sessionId,
    });
  }
  return "stored";
}

export const isWatched = (bot: Pick<BotRow, "liveUntil">, now = Date.now()) =>
  (bot.liveUntil?.getTime() ?? 0) > now;

/** Stops the computer the live screen kept on. eve resumes it on the bot's next turn. */
export async function stopComputer(bot: BotRow): Promise<void> {
  return await stopComputerObserved(bot, "internal", randomUUID());
}

export async function stopComputerObserved(
  bot: BotRow,
  entryPoint: "cron" | "http" | "internal" | "workflow",
  operationId: string
): Promise<void> {
  const startedAt = performance.now();
  observeOperation({
    botId: bot.id,
    entryPoint,
    flow: "live",
    operationId,
    outcome: "started",
    sessionId: bot.sessionId,
    stage: "session",
  });
  try {
    if (await viaDevRelay(bot, "DELETE")) {
      observeOperation({
        botId: bot.id,
        durationMs: performance.now() - startedAt,
        entryPoint,
        flow: "live",
        operationId,
        outcome: "completed",
        sessionId: bot.sessionId,
        stage: "session",
      });
      return;
    }
    await stopComputerInSandbox(bot);
    observeOperation({
      botId: bot.id,
      durationMs: performance.now() - startedAt,
      entryPoint,
      flow: "live",
      operationId,
      outcome: "completed",
      sessionId: bot.sessionId,
      stage: "session",
    });
  } catch (error) {
    observeOperation({
      botId: bot.id,
      durationMs: performance.now() - startedAt,
      entryPoint,
      errorCode: operationErrorCode(error),
      flow: "live",
      operationId,
      outcome: "failed",
      sessionId: bot.sessionId,
      stage: "session",
    });
    throw error;
  }
}

/** A caller with an explicitly verified session can stop that isolated computer. */
export async function stopComputerInSandbox(bot: BotRow): Promise<void> {
  const found = await computer(bot);
  if (!found) {
    return;
  }
  // Stop the browser owned by this sandbox before stopping the VM. Do not run a command on a
  // stopped persistent sandbox: Sandbox.runCommand would resume it and defeat the shutdown.
  if (found.sandbox.status === "running") {
    await found.sandbox
      .runCommand({ args: ["stop"], cmd: "desktop-browser" })
      .catch(() => {
        // The sandbox stop below is still safe if the browser helper is gone.
      });
  }
  await found.sandbox.stop();
}

/**
 * The bot may still need its computer (H-16/H-33): an open turn (running, waiting for the user, or not
 * verified as gone) or a message eve admitted that no turn took yet. Only `session.ended` frees it.
 */
async function botWorking(sessionId: string): Promise<boolean> {
  const turn = await sessionTurn(sessionId);
  if (turn.state === "unknown") {
    console.warn(
      "live: the bot's turn shows no progress; keeping its computer",
      {
        lastProgressAt: turn.lastProgressAt,
        sessionId,
        turnId: turn.turnId,
      }
    );
  }
  return sessionBusy(turn);
}

/** Clears an expired lease only while it is still the one observed (a heartbeat changes it). */
async function clearLease(
  botId: string,
  sessionId: string | null,
  observed: Date
): Promise<boolean> {
  const cleared = await db()
    .update(bots)
    .set({ liveUntil: null })
    .where(
      and(
        eq(bots.id, botId),
        sessionId === null
          ? isNull(bots.sessionId)
          : eq(bots.sessionId, sessionId),
        // The row keeps microseconds; the observed Date kept milliseconds.
        sql`date_trunc('milliseconds', ${bots.liveUntil}) = ${observed.toISOString()}::timestamptz`,
        lte(bots.liveUntil, sql`now()`)
      )
    )
    .returning({ id: bots.id });
  return cleared.length > 0;
}

/**
 * Once its time is up (no viewer, no recent chat): stops the computer the hub kept on, unless the bot
 * is working (its own turn's end stops it then). While request_login holds it, gives it more time
 * instead. Returns false while it should stay on (the watch looks again a minute later).
 */
export async function stopIfUnwatched(
  slug: string,
  now = Date.now()
): Promise<boolean> {
  const bot = await getBot(slug);
  if (!bot) {
    return true;
  }
  const { sessionId } = bot;
  const held = sessionId ? await activeHold(bot.id, sessionId) : null;
  if (held) {
    await extendHeldComputer(bot, held).catch((error: unknown) => {
      // The sandbox's own timeout still bounds it; the next minute retries.
      console.warn("live: could not extend a held computer", {
        error,
        slug,
      });
    });
    return false;
  }
  if (!bot.liveUntil) {
    return true;
  }
  if (bot.liveUntil.getTime() > now) {
    return false;
  }
  const observed = bot.liveUntil;
  if (!sessionId) {
    await clearLease(bot.id, null, observed);
    return true;
  }
  // The stop's permission, bound to this session and generation. Without it (a heartbeat, a hold,
  // the bot's own suspend hook, a new session) look again later.
  const claim = await claimShutdown(bot.id, sessionId);
  if (!claim) {
    return false;
  }
  try {
    await syncBot(bot).catch(() => {
      // The next reconciliation run will retry the final turn sync.
    });
    if (await botWorking(sessionId)) {
      // Its own turn's end stops it. A heartbeat since the first read keeps the newer lease, and
      // this watch goes on for it.
      return await clearLease(bot.id, sessionId, observed);
    }
    // Re-read after sync and the activity check: anything that moved since the claim wins.
    if (!(await confirmShutdown(bot.id, claim, "stopping"))) {
      return false;
    }
    await stopComputerObserved({ ...bot, sessionId }, "workflow", randomUUID());
    // A heartbeat during the stop keeps its lease (and this watch) for the reopened screen.
    return await clearLease(bot.id, sessionId, observed);
  } finally {
    await releaseShutdown(bot.id, claim.claim);
  }
}
