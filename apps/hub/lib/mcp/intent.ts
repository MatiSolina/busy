import { randomBytes, timingSafeEqual } from "node:crypto";

export const CONNECT_INTENT_TTL_MS = 10 * 60 * 1000;
export const CONNECT_INTENT_BYTES = 32;
export const CONNECT_INTENT_MAX_TICKET_LENGTH = 128;

export interface ConnectIntent {
  expiresAt: number;
  token: string;
}

/** Internal control flow: abort the row transaction without changing its ciphertext or status. */
export class ConnectIntentMismatchError extends Error {
  constructor() {
    super("MCP connect intent is invalid or expired");
    this.name = "ConnectIntentMismatchError";
  }
}

/** Create a short-lived, one-use browser intent. The token is only ever persisted encrypted. */
export function createConnectIntent(now = Date.now()): ConnectIntent {
  return {
    expiresAt: now + CONNECT_INTENT_TTL_MS,
    token: randomBytes(CONNECT_INTENT_BYTES).toString("base64url"),
  };
}

/** Constant-time comparison for a URL ticket, with cheap bounds before allocation. */
export function validConnectIntent(
  intent: ConnectIntent | undefined,
  ticket: string | null,
  now = Date.now()
): boolean {
  if (
    !(intent && ticket) ||
    ticket.length > CONNECT_INTENT_MAX_TICKET_LENGTH ||
    !Number.isSafeInteger(intent.expiresAt) ||
    intent.expiresAt <= now
  ) {
    return false;
  }
  const expected = Buffer.from(intent.token, "utf8");
  const supplied = Buffer.from(ticket, "utf8");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

/** Consume only a matching, unexpired intent; mismatches return null without changing the input. */
export function consumeConnectIntent<
  T extends { connectIntent?: ConnectIntent },
>(data: T, ticket: string | null, now = Date.now()): T | null {
  if (!validConnectIntent(data.connectIntent, ticket, now)) {
    return null;
  }
  const next = { ...data };
  // biome-ignore lint/performance/noDelete: Consuming an intent removes the one-use token from encrypted state.
  delete next.connectIntent;
  return next;
}
