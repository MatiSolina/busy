import { randomUUID } from "node:crypto";
import { and, asc, eq, lt } from "drizzle-orm";
import {
  aiSubscriptionAttempts,
  aiSubscriptionConnections,
  aiSubscriptionHosts,
  db,
} from "@/lib/db";
import { need } from "@/lib/env";
import { decryptOAuth, encryptOAuth } from "@/lib/mcp/crypto";
import { type Stages, span } from "@/lib/trace";
import {
  finishSubscriptionAuth,
  listSubscriptionModels,
  refreshSubscriptionCredentials,
  startSubscriptionAuth,
  validateSubscriptionCallback,
} from "./subscription-protocols";
import type {
  PublicSubscriptionAttempt,
  SubscriptionAttempt,
  SubscriptionCompletion,
  SubscriptionCredentials,
  SubscriptionModel,
  SubscriptionProvider,
} from "./subscription-types";
import { SubscriptionConnectionError } from "./subscription-types";

const HOST_ROW = "default";
const ATTEMPT_TTL_MS = 15 * 60 * 1000;
const MIN_POLL_MS = 1000;
const ACCESS_DENIED_RE = /declined|denied/u;
// Requests refresh a grant this close to expiry. The cron refreshes earlier so
// the first request after an idle hour does not wait on the token endpoint.
const REQUEST_REFRESH_MARGIN_MS = 60_000;
const CRON_REFRESH_MARGIN_MS = 30 * 60 * 1000;

function isSubscriptionConnectionError(
  error: unknown
): error is SubscriptionConnectionError {
  return (
    error instanceof SubscriptionConnectionError ||
    (error !== null &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "SubscriptionConnectionError")
  );
}

interface ProtocolOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: number;
  redirectUri?: string;
}

const secret = () => need("SESSION_SECRET");
const aad = (kind: "attempt" | "credentials", id: string) =>
  `busy:ai:${kind}:${id}`;

function decryptSubscriptionCredentials(
  sealedCredentials: string,
  provider: SubscriptionProvider,
  encryptionSecret: string
): SubscriptionCredentials {
  try {
    return decryptOAuth<SubscriptionCredentials>(
      sealedCredentials,
      aad("credentials", provider),
      encryptionSecret
    );
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: SubscriptionConnectionError receives ErrorOptions as its third argument.
    throw new SubscriptionConnectionError(
      "This subscription connection cannot be read. Reconnect it in Settings.",
      "connection_expired",
      { cause: error }
    );
  }
}

export class SubscriptionAttemptNotFoundError extends Error {
  constructor() {
    super("Subscription sign-in was not found or expired.");
    this.name = "SubscriptionAttemptNotFoundError";
  }
}

export class SubscriptionPollTooSoonError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Subscription sign-in is still waiting for approval.");
    this.name = "SubscriptionPollTooSoonError";
    this.retryAfterMs = retryAfterMs;
  }
}

function nowMs() {
  return Date.now();
}

async function hostId(): Promise<string> {
  const now = new Date();
  const existing = await db()
    .select({ hostId: aiSubscriptionHosts.hostId })
    .from(aiSubscriptionHosts)
    .where(eq(aiSubscriptionHosts.id, HOST_ROW));
  if (existing[0]?.hostId) {
    return existing[0].hostId;
  }
  const next = `urn:uuid:${randomUUID()}`;
  await db()
    .insert(aiSubscriptionHosts)
    .values({ hostId: next, id: HOST_ROW, updatedAt: now })
    .onConflictDoNothing({ target: aiSubscriptionHosts.id });
  const [row] = await db()
    .select({ hostId: aiSubscriptionHosts.hostId })
    .from(aiSubscriptionHosts)
    .where(eq(aiSubscriptionHosts.id, HOST_ROW));
  return row?.hostId ?? next;
}

export async function startConnection(
  provider: SubscriptionProvider,
  _user: string,
  options: ProtocolOptions = {}
): Promise<PublicSubscriptionAttempt> {
  const id = randomUUID();
  const host = await hostId();
  const started = await startSubscriptionAuth(provider, host, {
    ...options,
    attemptId: id,
  });
  const now = options.now ?? nowMs();
  const attempt: SubscriptionAttempt = { ...started.attempt };
  const expiresAt = new Date(attempt.expiresAt || now + ATTEMPT_TTL_MS);
  await db()
    .delete(aiSubscriptionAttempts)
    .where(
      and(
        eq(aiSubscriptionAttempts.provider, provider),
        eq(aiSubscriptionAttempts.user, _user),
        lt(aiSubscriptionAttempts.expiresAt, new Date(now))
      )
    );
  await db()
    .insert(aiSubscriptionAttempts)
    .values({
      expiresAt,
      id,
      nextPollAt: new Date(now),
      provider,
      sealedAttempt: encryptOAuth(attempt, aad("attempt", id), secret()),
      user: _user,
    });
  return { ...started.public, attemptId: id, expiresAt: expiresAt.getTime() };
}

export type CompletionResult =
  | SubscriptionCompletion
  | { code?: "access_denied" | "provider_error"; status: "failed" };

function completedResult(
  attempt: SubscriptionAttempt
): CompletionResult | null {
  if (attempt.completion === "connected") {
    return { status: "connected" };
  }
  if (attempt.completion === "failed") {
    throw new SubscriptionConnectionError(
      "The subscription connection failed.",
      attempt.completionCode === "access_denied"
        ? "access_denied"
        : "connection_failed"
    );
  }
  return null;
}

async function markFailed(
  tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0],
  row: { id: string },
  attempt: SubscriptionAttempt,
  code: "access_denied" | "provider_error"
) {
  await tx
    .update(aiSubscriptionAttempts)
    .set({
      sealedAttempt: encryptOAuth(
        {
          ...attempt,
          completion: "failed",
          completionCode: code,
          deviceCode: undefined,
          nonce: undefined,
          verifier: undefined,
        },
        aad("attempt", row.id),
        secret()
      ),
    })
    .where(eq(aiSubscriptionAttempts.id, row.id));
  const result: {
    code?: "access_denied" | "provider_error";
    status: "failed";
  } = {
    status: "failed",
  };
  Object.defineProperty(result, "code", {
    configurable: true,
    value: code,
  });
  return result;
}

async function finishAttemptLocked(
  tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0],
  row: { id: string },
  attempt: SubscriptionAttempt,
  provider: SubscriptionProvider,
  input: { callbackUrl?: string },
  options: ProtocolOptions,
  now: number
): Promise<CompletionResult> {
  let credentials: SubscriptionCredentials | null;
  try {
    credentials = await finishSubscriptionAuth(
      attempt,
      input.callbackUrl,
      options
    );
  } catch (error) {
    return markFailed(
      tx,
      row,
      attempt,
      error instanceof SubscriptionConnectionError &&
        ACCESS_DENIED_RE.test(error.message)
        ? "access_denied"
        : "provider_error"
    );
  }
  if (!credentials) {
    const interval = Math.max(attempt.intervalMs || 5000, MIN_POLL_MS);
    await tx
      .update(aiSubscriptionAttempts)
      .set({
        nextPollAt: new Date(now + interval),
        sealedAttempt: encryptOAuth(attempt, aad("attempt", row.id), secret()),
      })
      .where(eq(aiSubscriptionAttempts.id, row.id));
    return { intervalMs: interval, status: "pending" };
  }
  let models: SubscriptionModel[];
  try {
    models = await listSubscriptionModels(provider, credentials, options);
  } catch {
    return markFailed(tx, row, attempt, "provider_error");
  }
  if (!models.length) {
    return markFailed(tx, row, attempt, "provider_error");
  }
  await tx
    .insert(aiSubscriptionConnections)
    .values({
      accountId: credentials.accountId,
      connectedAt: new Date(now),
      models,
      provider,
      sealedCredentials: encryptOAuth(
        credentials,
        aad("credentials", provider),
        secret()
      ),
      updatedAt: new Date(now),
    })
    .onConflictDoUpdate({
      set: {
        accountId: credentials.accountId,
        models,
        sealedCredentials: encryptOAuth(
          credentials,
          aad("credentials", provider),
          secret()
        ),
        updatedAt: new Date(now),
      },
      target: aiSubscriptionConnections.provider,
    });
  await tx
    .update(aiSubscriptionAttempts)
    .set({
      sealedAttempt: encryptOAuth(
        {
          ...attempt,
          completion: "connected",
          deviceCode: undefined,
          nonce: undefined,
          verifier: undefined,
        },
        aad("attempt", row.id),
        secret()
      ),
    })
    .where(eq(aiSubscriptionAttempts.id, row.id));
  return { status: "connected" };
}

export function completeConnection(
  provider: SubscriptionProvider,
  user: string,
  input: { attemptId: string; callbackUrl?: string },
  options: ProtocolOptions = {}
): Promise<CompletionResult> {
  const now = options.now ?? nowMs();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(aiSubscriptionAttempts)
      .where(
        and(
          eq(aiSubscriptionAttempts.id, input.attemptId),
          eq(aiSubscriptionAttempts.provider, provider),
          eq(aiSubscriptionAttempts.user, user)
        )
      )
      .for("update");
    if (!row || row.expiresAt.getTime() <= now) {
      if (row) {
        await tx
          .delete(aiSubscriptionAttempts)
          .where(eq(aiSubscriptionAttempts.id, row.id));
      }
      throw new SubscriptionAttemptNotFoundError();
    }
    if (row.nextPollAt.getTime() > now && !input.callbackUrl) {
      throw new SubscriptionPollTooSoonError(row.nextPollAt.getTime() - now);
    }
    const attempt = decryptOAuth<SubscriptionAttempt>(
      row.sealedAttempt,
      aad("attempt", row.id),
      secret()
    );
    if (input.callbackUrl && attempt.provider === "chatgpt") {
      // Validate the callback shape and state before any failure receipt is
      // written. A forged callback must not invalidate a valid login attempt.
      validateSubscriptionCallback(input.callbackUrl, attempt);
    }
    const completed = completedResult(attempt);
    if (completed) {
      return completed;
    }
    if (attempt.provider === "chatgpt" && !input.callbackUrl) {
      const interval = Math.max(attempt.intervalMs || 5000, MIN_POLL_MS);
      await tx
        .update(aiSubscriptionAttempts)
        .set({ nextPollAt: new Date(now + interval) })
        .where(eq(aiSubscriptionAttempts.id, row.id));
      return { intervalMs: interval, status: "pending" };
    }
    return finishAttemptLocked(tx, row, attempt, provider, input, options, now);
  });
}

/** Complete a local loopback callback without requiring a Busy session cookie. */
export async function completeLoopbackCallback(
  attemptId: string,
  callbackUrl: string,
  options: ProtocolOptions = {}
): Promise<CompletionResult> {
  const [row] = await db()
    .select({
      provider: aiSubscriptionAttempts.provider,
      user: aiSubscriptionAttempts.user,
    })
    .from(aiSubscriptionAttempts)
    .where(
      and(
        eq(aiSubscriptionAttempts.id, attemptId),
        eq(aiSubscriptionAttempts.provider, "chatgpt")
      )
    );
  if (!row) {
    throw new SubscriptionAttemptNotFoundError();
  }
  return completeConnection(
    row.provider,
    row.user,
    { attemptId, callbackUrl },
    options
  );
}

export async function cancelConnectionAttempt(
  provider: SubscriptionProvider,
  user: string,
  attemptId: string
): Promise<void> {
  const deleted = await db()
    .delete(aiSubscriptionAttempts)
    .where(
      and(
        eq(aiSubscriptionAttempts.id, attemptId),
        eq(aiSubscriptionAttempts.provider, provider),
        eq(aiSubscriptionAttempts.user, user)
      )
    )
    .returning({ id: aiSubscriptionAttempts.id });
  if (!deleted.length) {
    throw new SubscriptionAttemptNotFoundError();
  }
}

export async function listSubscriptionConnections(): Promise<
  Array<{
    provider: SubscriptionProvider;
    models: SubscriptionModel[];
    accountLabel: string | null;
  }>
> {
  const rows = await db()
    .select()
    .from(aiSubscriptionConnections)
    .orderBy(asc(aiSubscriptionConnections.provider));
  const encryptionSecret = secret();
  const connections: Array<{
    provider: SubscriptionProvider;
    models: SubscriptionModel[];
    accountLabel: string | null;
  }> = [];
  for (const row of rows) {
    try {
      decryptSubscriptionCredentials(
        row.sealedCredentials,
        row.provider,
        encryptionSecret
      );
    } catch (error) {
      if (
        isSubscriptionConnectionError(error) &&
        error.code === "connection_expired"
      ) {
        continue;
      }
      throw error;
    }
    connections.push({
      accountLabel: row.accountId
        ? `Account ${row.accountId.slice(0, 8)}`
        : null,
      models: row.models,
      provider: row.provider,
    });
  }
  return connections;
}

export async function disconnectConnection(provider: SubscriptionProvider) {
  await db()
    .delete(aiSubscriptionAttempts)
    .where(eq(aiSubscriptionAttempts.provider, provider));
  await db()
    .delete(aiSubscriptionConnections)
    .where(eq(aiSubscriptionConnections.provider, provider));
}

/**
 * Remove a grant rejected by the provider only when it is still the exact
 * grant used for that request. A concurrent reconnect or refresh therefore
 * cannot be deleted by a late 401 from an older access token.
 */
export function invalidateSubscriptionAccess(
  provider: SubscriptionProvider,
  expected: SubscriptionCredentials
): Promise<boolean> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(aiSubscriptionConnections)
      .where(eq(aiSubscriptionConnections.provider, provider))
      .for("update");
    if (!row) {
      return false;
    }
    const current = decryptSubscriptionCredentials(
      row.sealedCredentials,
      provider,
      secret()
    );
    if (
      current.accessToken !== expected.accessToken ||
      current.refreshToken !== expected.refreshToken
    ) {
      return false;
    }
    await tx
      .delete(aiSubscriptionConnections)
      .where(eq(aiSubscriptionConnections.provider, provider));
    return true;
  });
}

interface SubscriptionAccess {
  credentials: SubscriptionCredentials;
  models: SubscriptionModel[];
}

function notConnected(): SubscriptionConnectionError {
  return new SubscriptionConnectionError(
    "This subscription is not connected.",
    "connection_not_connected"
  );
}

/** Refresh under the row lock; a concurrent caller re-reads the rotated grant. */
function refreshLocked(
  provider: SubscriptionProvider,
  options: ProtocolOptions,
  refreshMarginMs: number
) {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(aiSubscriptionConnections)
      .where(eq(aiSubscriptionConnections.provider, provider))
      .for("update");
    if (!row) {
      throw notConnected();
    }
    const current = decryptSubscriptionCredentials(
      row.sealedCredentials,
      provider,
      secret()
    );
    const now = options.now ?? nowMs();
    if (current.expiresAt > now + refreshMarginMs) {
      return {
        credentials: current,
        expired: false as const,
        models: row.models,
      };
    }
    let refreshed: SubscriptionCredentials;
    try {
      refreshed = await refreshSubscriptionCredentials(
        provider,
        current,
        options
      );
    } catch (error) {
      if (
        isSubscriptionConnectionError(error) &&
        error.code === "connection_expired"
      ) {
        await tx
          .delete(aiSubscriptionConnections)
          .where(eq(aiSubscriptionConnections.provider, provider));
        return { cause: error, expired: true as const };
      }
      throw error;
    }
    await tx
      .update(aiSubscriptionConnections)
      .set({
        accountId: refreshed.accountId,
        sealedCredentials: encryptOAuth(
          refreshed,
          aad("credentials", provider),
          secret()
        ),
        updatedAt: new Date(now),
      })
      .where(eq(aiSubscriptionConnections.provider, provider));
    return {
      credentials: refreshed,
      expired: false as const,
      models: row.models,
    };
  });
}

export async function getSubscriptionAccess(
  provider: SubscriptionProvider,
  options: ProtocolOptions & { refreshMarginMs?: number; stages?: Stages } = {}
): Promise<SubscriptionAccess> {
  const { refreshMarginMs = REQUEST_REFRESH_MARGIN_MS, stages } = options;
  // Most calls reuse a valid grant. Read it without BEGIN/FOR UPDATE/COMMIT;
  // only a refresh needs serialization, and it must re-read under the lock.
  const [available] = await db()
    .select()
    .from(aiSubscriptionConnections)
    .where(eq(aiSubscriptionConnections.provider, provider));
  if (!available) {
    throw notConnected();
  }
  const credentials = decryptSubscriptionCredentials(
    available.sealedCredentials,
    provider,
    secret()
  );
  if (credentials.expiresAt > (options.now ?? nowMs()) + refreshMarginMs) {
    return { credentials, models: available.models };
  }
  // A request that lands here waits on the provider's token endpoint (and, for
  // ChatGPT, a JWKS fetch on a cold instance). `stageAiRefreshMs` shows it.
  const result = await span(
    "ai.refresh",
    () => refreshLocked(provider, options, refreshMarginMs),
    stages
  );
  if (result.expired) {
    const wrapped = new SubscriptionConnectionError(
      "This subscription connection expired or was revoked. Reconnect it in Settings.",
      "connection_expired"
    );
    Object.defineProperty(wrapped, "cause", {
      configurable: true,
      value: result.cause,
    });
    throw wrapped;
  }
  return { credentials: result.credentials, models: result.models };
}

/**
 * Cron: rotate every grant that expires within the next half hour, so chat
 * requests keep finding a valid token instead of refreshing inline.
 */
export async function refreshExpiringSubscriptions(
  options: ProtocolOptions = {}
): Promise<Partial<Record<SubscriptionProvider, "failed" | "ok">>> {
  const rows = await db()
    .select({ provider: aiSubscriptionConnections.provider })
    .from(aiSubscriptionConnections);
  const results = await Promise.all(
    rows.map(({ provider }) =>
      getSubscriptionAccess(provider, {
        ...options,
        refreshMarginMs: CRON_REFRESH_MARGIN_MS,
      }).then(
        () => [provider, "ok"] as const,
        () => [provider, "failed"] as const
      )
    )
  );
  return Object.fromEntries(results);
}
