export type SubscriptionProvider = "chatgpt" | "grok";

export interface SubscriptionModel {
  id: string;
  label: string;
}

/** Server-only OAuth state. Never serialize this object to a browser. */
export interface SubscriptionCredentials {
  accessToken: string;
  accountId: string;
  clientId: string;
  expiresAt: number;
  refreshToken: string;
}

/** Server-only transaction, encrypted at rest by the connection store. */
export interface SubscriptionAttempt {
  clientId?: string;
  completion?: "connected" | "failed";
  completionCode?: "provider_error" | "access_denied";
  deviceCode?: string;
  expiresAt: number;
  hostId?: string;
  intervalMs: number;
  kind: "browser" | "device";
  nonce?: string;
  provider: SubscriptionProvider;
  redirectUri?: string;
  state?: string;
  userCode?: string;
  verifier?: string;
}

export interface PublicSubscriptionAttempt {
  attemptId: string;
  expiresAt: number;
  intervalMs: number;
  kind: "browser" | "device";
  provider: SubscriptionProvider;
  url: string;
  userCode?: string;
}

export interface SubscriptionCompletion {
  intervalMs?: number;
  status: "pending" | "connected";
}

export class SubscriptionConnectionError extends Error {
  readonly code:
    | "access_denied"
    | "connection_expired"
    | "connection_failed"
    | "connection_not_connected"
    | "provider_error";

  constructor(
    message: string,
    code: SubscriptionConnectionError["code"] = "connection_failed",
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SubscriptionConnectionError";
    this.code = code;
  }
}
