"use client";

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { desktopSubscriptions } from "@/lib/ai/desktop-subscriptions";
import {
  type AiIssueCode,
  aiIssueFromResponse,
  aiIssueGuidance,
} from "@/lib/ai/errors";
import type { PublicSubscriptionAttempt } from "@/lib/ai/subscription-types";
import type { AiProviderOption, AiSettingsSnapshot } from "@/lib/ai/types";

type SelectableProvider = Extract<AiSettingsSnapshot["provider"], string>;
type SubscriptionProvider = Extract<SelectableProvider, "chatgpt" | "grok">;

export interface AiConnectionContextValue {
  activeAttempt: PublicSubscriptionAttempt | null;
  cancelSubscription: () => void;
  connecting: boolean;
  connectionError: string | null;
  disconnect: (provider: SubscriptionProvider) => Promise<boolean>;
  dismissOnboarding: () => void;
  error: string | null;
  loading: boolean;
  onboardingOpen: boolean;
  refresh: () => Promise<void>;
  saveProvider: (
    provider?: SelectableProvider | null,
    model?: string | null
  ) => Promise<boolean>;
  saving: boolean;
  selectedModel: string | null;
  selectedProvider: SelectableProvider | null;
  selectModel: (model: string) => void;
  selectProvider: (provider: SelectableProvider) => void;
  snapshot: AiSettingsSnapshot | null;
  startSubscription: (provider: SubscriptionProvider) => Promise<boolean>;
}

const AiConnectionContext = createContext<AiConnectionContextValue | null>(
  null
);

const PROVIDER_LABELS: Record<SelectableProvider, string> = {
  chatgpt: "ChatGPT",
  gateway: "AI Gateway",
  grok: "Grok",
  "token-pass": "Token Pass",
};

/** Legacy route codes accepted while all connection routes converge on AiIssue. */
const LEGACY_ERROR_CODES: Record<string, AiIssueCode> = {
  access_denied: "access_denied",
  attempt_not_found: "attempt_not_found",
  auth_required: "connection_not_connected",
  could_not_cancel: "could_not_cancel",
  could_not_connect: "connection_failed",
  could_not_disconnect: "could_not_disconnect",
  could_not_load: "could_not_load",
  could_not_save: "could_not_save",
  could_not_start_connection: "could_not_start_connection",
  credits_exhausted: "provider_quota_exceeded",
  invalid_callback: "invalid_callback",
  invalid_data: "invalid_data",
  invalid_request: "invalid_inference_input",
  model_not_found: "model_unavailable",
  network_error: "provider_unavailable",
  provider_auth_required: "connection_not_connected",
  provider_forbidden: "provider_access_denied",
  provider_quota_exceeded: "provider_quota_exceeded",
  provider_rate_limited: "provider_rate_limited",
  provider_unavailable: "provider_unavailable",
  quota_exceeded: "provider_quota_exceeded",
  rate_limited: "provider_rate_limited",
  subscription_cancelled: "could_not_cancel",
  subscription_connection_failed: "connection_failed",
  subscription_expired: "connection_expired",
  unauthorized: "unauthorized",
};

const MODEL_ISSUE_CODES = new Set<AiIssueCode>([
  "invalid_model",
  "model_unavailable",
  "subscription_model_unavailable",
]);

class SubscriptionAttemptError extends Error {
  readonly retryAfterMs?: number;
  readonly terminal: boolean;

  constructor(
    message: string,
    terminal: boolean,
    retryAfterMs?: number,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "SubscriptionAttemptError";
    this.terminal = terminal;
    this.retryAfterMs = retryAfterMs;
  }
}

function isProvider(value: unknown): value is SelectableProvider {
  return (
    value === "token-pass" ||
    value === "gateway" ||
    value === "chatgpt" ||
    value === "grok"
  );
}

function isProviderOption(value: unknown): value is AiProviderOption {
  if (!value || typeof value !== "object") {
    return false;
  }
  const option = value as Partial<AiProviderOption>;
  return (
    typeof option.id === "string" &&
    typeof option.label === "string" &&
    typeof option.description === "string" &&
    typeof option.status === "string"
  );
}

function parseSnapshot(value: unknown): AiSettingsSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("AI settings are unavailable.");
  }
  const snapshot = value as Partial<AiSettingsSnapshot>;
  if (snapshot.provider !== null && !isProvider(snapshot.provider)) {
    throw new Error("AI settings are unavailable.");
  }
  if (
    typeof snapshot.onboardingCompleted !== "boolean" ||
    !Array.isArray(snapshot.providers) ||
    !snapshot.providers.every(isProviderOption)
  ) {
    throw new Error("AI settings are unavailable.");
  }
  return snapshot as AiSettingsSnapshot;
}

function errorMessage(
  body: unknown,
  fallback: string,
  provider?: SelectableProvider,
  status?: number
) {
  const reason =
    body && typeof body === "object"
      ? (() => {
          const { code, error: message } = body as {
            code?: unknown;
            error?: unknown;
          };
          return typeof code === "string" ? code : message;
        })()
      : null;
  const normalized =
    typeof reason === "string" ? (LEGACY_ERROR_CODES[reason] ?? reason) : null;
  const issue = aiIssueFromResponse(normalized ? { code: normalized } : body, {
    origin: "busy",
    provider: provider ?? null,
    status,
  });
  if (!issue) {
    return fallback;
  }
  const guidance = MODEL_ISSUE_CODES.has(issue.code)
    ? "Choose another model in AI connection Settings."
    : aiIssueGuidance(issue);
  return `${issue.message} ${guidance}`;
}

const ignorePromise = () => undefined;

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function attemptFromBody(body: unknown): PublicSubscriptionAttempt | null {
  const candidate =
    body && typeof body === "object" && "attempt" in body
      ? (body as { attempt?: unknown }).attempt
      : body;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const attempt = candidate as Partial<PublicSubscriptionAttempt>;
  if (
    typeof attempt.attemptId !== "string" ||
    (attempt.provider !== "chatgpt" && attempt.provider !== "grok") ||
    (attempt.kind !== "browser" && attempt.kind !== "device") ||
    typeof attempt.url !== "string" ||
    typeof attempt.expiresAt !== "number" ||
    typeof attempt.intervalMs !== "number"
  ) {
    return null;
  }
  return attempt as PublicSubscriptionAttempt;
}

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object"
    ? (body as Record<string, unknown>)
    : {};
}

function pendingResult(body: Record<string, unknown>) {
  const retryAfterMs = body.retryAfterMs ?? body.intervalMs;
  return {
    intervalMs: typeof retryAfterMs === "number" ? retryAfterMs : undefined,
    status: "pending" as const,
  };
}

export function isTerminalCompletion(status: number, code: unknown) {
  return (
    [400, 404, 410].includes(status) ||
    [
      "access_denied",
      "auth_required",
      "attempt_not_found",
      "could_not_connect",
      "connection_expired",
      "connection_failed",
      "invalid_data",
      "invalid_callback",
      "invalid_request",
      "model_not_found",
      "model_unavailable",
      "provider_auth_required",
      "provider_forbidden",
      "provider_quota_exceeded",
      "subscription_connection_failed",
      "subscription_expired",
    ].includes(String(code))
  );
}

interface AttemptRef {
  current: PublicSubscriptionAttempt | null;
}

interface TimerRef {
  current: ReturnType<typeof setTimeout> | null;
}

function scheduleAttemptPolling({
  attempt,
  attemptRef,
  completeAttempt,
  pollDelayRef,
  pollTimerRef,
}: {
  attempt: PublicSubscriptionAttempt;
  attemptRef: AttemptRef;
  completeAttempt: () => Promise<boolean>;
  pollDelayRef: { current: number };
  pollTimerRef: TimerRef;
}) {
  if (attempt.kind !== "device" && attempt.provider !== "chatgpt") {
    return;
  }
  const { attemptId } = attempt;
  const poll = () => {
    if (!attemptRef.current || attemptRef.current.attemptId !== attemptId) {
      return;
    }
    completeAttempt().then((connected) => {
      if (!connected && attemptRef.current?.attemptId === attemptId) {
        pollTimerRef.current = setTimeout(
          poll,
          Math.min(
            Math.max(250, pollDelayRef.current),
            Math.max(250, attempt.expiresAt - Date.now())
          )
        );
      }
    });
  };
  pollTimerRef.current = setTimeout(poll, pollDelayRef.current);
}

async function openSubscriptionAuthorization({
  attempt,
  desktop,
  popup,
  setConnectionError,
}: {
  attempt: PublicSubscriptionAttempt;
  desktop: ReturnType<typeof desktopSubscriptions>;
  popup: Window | null;
  setConnectionError: (message: string) => void;
}) {
  if (attempt.provider === "chatgpt" && desktop) {
    await desktop.openChatGpt(attempt);
    return;
  }
  if (attempt.provider === "grok" && desktop) {
    window.open(attempt.url, "_blank", "noopener,noreferrer");
    return;
  }
  if (popup) {
    popup.location.replace(attempt.url);
    return;
  }
  const label = PROVIDER_LABELS[attempt.provider];
  setConnectionError(
    `The ${label} authorization window was blocked. Allow pop-ups for Busy, then use Reopen authorization.`
  );
}

function cancelRemoteAttempt(attempt: PublicSubscriptionAttempt) {
  return fetch(`/api/ai/connections/${attempt.provider}/complete`, {
    body: JSON.stringify({ attemptId: attempt.attemptId }),
    headers: { "Content-Type": "application/json" },
    method: "DELETE",
  }).catch(ignorePromise);
}

type DesktopSubscriptionBridge = ReturnType<typeof desktopSubscriptions>;

function cancelDesktopSubscription(desktop: DesktopSubscriptionBridge) {
  return desktop
    ? desktop.cancelChatGpt().catch(ignorePromise)
    : Promise.resolve();
}

async function prepareChatGptRedirectUri(
  desktop: DesktopSubscriptionBridge,
  generation: number,
  generationRef: { current: number }
): Promise<string | null | undefined> {
  if (!desktop) {
    return undefined;
  }
  const prepared = await desktop.prepareChatGpt();
  if (generationRef.current !== generation) {
    return null;
  }
  return prepared.redirectUri;
}

async function startRemoteSubscription(
  provider: SubscriptionProvider,
  redirectUri?: string
): Promise<PublicSubscriptionAttempt> {
  const response = await fetch(`/api/ai/connections/${provider}`, {
    ...(redirectUri
      ? {
          body: JSON.stringify({ redirectUri }),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(
      errorMessage(
        body,
        "Couldn't start that connection.",
        provider,
        response.status
      )
    );
  }
  return (
    attemptFromBody(body) ??
    (() => {
      throw new Error("Couldn't start that connection.");
    })()
  );
}

function prepareAuthorizationPopup(
  desktop: DesktopSubscriptionBridge
): Window | null {
  if (desktop || typeof window === "undefined") {
    return null;
  }
  const popup = window.open("about:blank", "_blank");
  if (popup) {
    popup.opener = null;
  }
  return popup;
}

async function cleanupFailedStart(
  startedAttempt: PublicSubscriptionAttempt | null,
  attemptRef: AttemptRef,
  setActiveAttempt: (attempt: PublicSubscriptionAttempt | null) => void,
  desktop: DesktopSubscriptionBridge
) {
  if (
    !startedAttempt ||
    attemptRef.current?.attemptId !== startedAttempt.attemptId
  ) {
    await cancelDesktopSubscription(desktop);
    return;
  }
  await cancelRemoteAttempt(startedAttempt);
  attemptRef.current = null;
  setActiveAttempt(null);
  await cancelDesktopSubscription(desktop);
}

async function completeSubscriptionRequest(
  attempt: PublicSubscriptionAttempt
): Promise<{ status: "pending" | "connected"; intervalMs?: number }> {
  let response: Response;
  try {
    response = await fetch(`/api/ai/connections/${attempt.provider}/complete`, {
      body: JSON.stringify({
        attemptId: attempt.attemptId,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch (cause) {
    const error = new SubscriptionAttemptError(
      `Busy couldn't reach ${PROVIDER_LABELS[attempt.provider]}. Busy will retry while this connection is valid.`,
      false
    );
    error.cause = cause;
    throw error;
  }
  const body = objectBody(await readBody(response));
  const code = body.error;
  if (!response.ok && code === "pending") {
    return pendingResult(body);
  }
  if (!response.ok) {
    throw new SubscriptionAttemptError(
      errorMessage(
        body,
        `Couldn't finish the ${PROVIDER_LABELS[attempt.provider]} connection.`,
        attempt.provider,
        response.status
      ),
      isTerminalCompletion(response.status, code)
    );
  }
  if (body.status === "pending") {
    return pendingResult(body);
  }
  if (body.status !== "connected") {
    throw new SubscriptionAttemptError(
      `Couldn't finish the ${PROVIDER_LABELS[attempt.provider]} connection. Start it again.`,
      true
    );
  }
  return { status: "connected" };
}

export function AiConnectionProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AiSettingsSnapshot | null>(null);
  const [selectedProvider, setSelectedProvider] =
    useState<SelectableProvider | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [activeAttempt, setActiveAttempt] =
    useState<PublicSubscriptionAttempt | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const requestRef = useRef<Promise<AiSettingsSnapshot | null> | null>(null);
  const attemptRef = useRef<PublicSubscriptionAttempt | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDelayRef = useRef(1000);
  const selectedProviderRef = useRef<SelectableProvider | null>(null);
  const draftSelectionRef = useRef(false);
  const attemptGenerationRef = useRef(0);
  const activeDesktopRef = useRef<DesktopSubscriptionBridge>(null);
  const activePopupRef = useRef<Window | null>(null);

  useEffect(() => {
    selectedProviderRef.current = selectedProvider;
  }, [selectedProvider]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
    }
    pollTimerRef.current = null;
  }, []);

  const finishAttempt = useCallback(
    (message: string) => {
      stopPolling();
      activePopupRef.current?.close();
      activePopupRef.current = null;
      const desktop = activeDesktopRef.current;
      activeDesktopRef.current = null;
      cancelDesktopSubscription(desktop);
      attemptRef.current = null;
      setActiveAttempt(null);
      setConnecting(false);
      setConnectionError(message);
    },
    [stopPolling]
  );

  const refresh = useCallback(async () => {
    if (requestRef.current) {
      await requestRef.current;
      return;
    }
    setLoading(true);
    setError(null);
    const request = fetch("/api/ai/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await readBody(response);
        if (!response.ok) {
          throw new Error(
            errorMessage(
              body,
              "Couldn't load AI settings.",
              undefined,
              response.status
            )
          );
        }
        return parseSnapshot(body);
      })
      .then((next) => {
        setSnapshot(next);
        if (draftSelectionRef.current === false) {
          setSelectedProvider(next.provider);
          setSelectedModel(next.model ?? null);
        }
        setError(null);
        setLoading(false);
        return next;
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "Couldn't load AI settings."
        );
        setLoading(false);
        return null;
      })
      .finally(() => {
        requestRef.current = null;
      });
    requestRef.current = request;
    await request;
  }, []);

  useEffect(() => {
    refresh().catch(ignorePromise);
    return stopPolling;
  }, [refresh, stopPolling]);

  const selectProvider = useCallback((provider: SelectableProvider) => {
    draftSelectionRef.current = true;
    setSelectedProvider(provider);
    setError(null);
  }, []);

  const selectModel = useCallback((model: string) => {
    draftSelectionRef.current = true;
    setSelectedModel(model || null);
    setError(null);
  }, []);

  const finishConnected = useCallback(
    async (attempt: PublicSubscriptionAttempt) => {
      stopPolling();
      const { provider } = attempt;
      activePopupRef.current?.close();
      activePopupRef.current = null;
      activeDesktopRef.current = null;
      attemptRef.current = null;
      setActiveAttempt(null);
      setConnecting(false);
      setConnectionError(null);
      await refresh();
      if (selectedProviderRef.current === null) {
        draftSelectionRef.current = true;
        setSelectedProvider(provider);
        selectedProviderRef.current = provider;
      }
    },
    [refresh, stopPolling]
  );

  const handleAttemptFailure = useCallback(
    (attempt: PublicSubscriptionAttempt, cause: unknown) => {
      if (attemptRef.current?.attemptId !== attempt.attemptId) {
        return false;
      }
      if (cause instanceof SubscriptionAttemptError && cause.terminal) {
        finishAttempt(cause.message);
        return false;
      }
      pollDelayRef.current = Math.min(
        15_000,
        Math.max(1000, pollDelayRef.current * 2)
      );
      setConnectionError(
        cause instanceof Error
          ? cause.message
          : `Couldn't finish the ${PROVIDER_LABELS[attempt.provider]} connection. Start it again.`
      );
      return false;
    },
    [finishAttempt]
  );

  const completeAttempt = useCallback(async (): Promise<boolean> => {
    const attempt = attemptRef.current;
    if (!attempt) {
      return false;
    }
    if (Date.now() >= attempt.expiresAt) {
      finishAttempt(
        errorMessage(
          { code: "connection_expired" },
          `Your ${PROVIDER_LABELS[attempt.provider]} connection window expired. Start it again.`,
          attempt.provider
        )
      );
      return false;
    }
    try {
      const result = await completeSubscriptionRequest(attempt);
      if (attemptRef.current?.attemptId !== attempt.attemptId) {
        return false;
      }
      if (result.status === "pending") {
        setConnectionError(null);
        pollDelayRef.current = Math.max(
          250,
          result.intervalMs ?? attempt.intervalMs
        );
        return false;
      }
      await finishConnected(attempt);
      return true;
    } catch (cause) {
      return handleAttemptFailure(attempt, cause);
    }
  }, [finishConnected, finishAttempt, handleAttemptFailure]);

  const startSubscription = useCallback(
    async (provider: SubscriptionProvider) => {
      const generation = attemptGenerationRef.current + 1;
      attemptGenerationRef.current = generation;
      stopPolling();
      setConnecting(true);
      setConnectionError(null);
      const desktop = desktopSubscriptions();
      const popup = prepareAuthorizationPopup(desktop);
      activeDesktopRef.current = provider === "chatgpt" ? desktop : null;
      activePopupRef.current = popup;
      let startedAttempt: PublicSubscriptionAttempt | null = null;
      try {
        const preparedRedirectUri = await prepareChatGptRedirectUri(
          provider === "chatgpt" ? desktop : null,
          generation,
          attemptGenerationRef
        );
        if (preparedRedirectUri === null) {
          popup?.close();
          return false;
        }
        const attempt = await startRemoteSubscription(
          provider,
          preparedRedirectUri
        );
        startedAttempt = attempt;
        if (attemptGenerationRef.current !== generation) {
          await cancelRemoteAttempt(attempt);
          popup?.close();
          return false;
        }
        attemptRef.current = attempt;
        setActiveAttempt(attempt);
        pollDelayRef.current = Math.max(250, attempt.intervalMs);
        await openSubscriptionAuthorization({
          attempt,
          desktop,
          popup,
          setConnectionError,
        });
        scheduleAttemptPolling({
          attempt,
          attemptRef,
          completeAttempt,
          pollDelayRef,
          pollTimerRef,
        });
        return true;
      } catch (cause) {
        popup?.close();
        if (activePopupRef.current === popup) {
          activePopupRef.current = null;
        }
        if (attemptGenerationRef.current !== generation) {
          return false;
        }
        activeDesktopRef.current = null;
        await cleanupFailedStart(
          startedAttempt,
          attemptRef,
          setActiveAttempt,
          desktop
        );
        setConnecting(false);
        setConnectionError(
          cause instanceof Error
            ? cause.message
            : `Couldn't start the ${PROVIDER_LABELS[provider]} connection.`
        );
        return false;
      }
    },
    [completeAttempt, stopPolling]
  );

  const cancelSubscription = useCallback(() => {
    const attempt = attemptRef.current;
    const desktop =
      activeDesktopRef.current ??
      (attempt?.provider === "chatgpt" ? desktopSubscriptions() : null);
    const popup = activePopupRef.current;
    if (attempt) {
      cancelRemoteAttempt(attempt);
    }
    attemptGenerationRef.current += 1;
    stopPolling();
    activeDesktopRef.current = null;
    activePopupRef.current = null;
    popup?.close();
    attemptRef.current = null;
    setActiveAttempt(null);
    setConnecting(false);
    setConnectionError(null);
    cancelDesktopSubscription(desktop);
  }, [stopPolling]);

  const disconnect = useCallback(
    async (provider: SubscriptionProvider) => {
      setConnectionError(null);
      try {
        const response = await fetch(`/api/ai/connections/${provider}`, {
          method: "DELETE",
        });
        const body = await readBody(response);
        if (!response.ok) {
          throw new Error(
            errorMessage(
              body,
              `Couldn't disconnect ${PROVIDER_LABELS[provider]}.`,
              provider,
              response.status
            )
          );
        }
        const wasSelected = selectedProviderRef.current === provider;
        await refresh();
        if (wasSelected) {
          draftSelectionRef.current = true;
          setSelectedProvider(provider);
          selectedProviderRef.current = provider;
        }
        return true;
      } catch (cause) {
        setConnectionError(
          cause instanceof Error
            ? cause.message
            : `Couldn't disconnect ${PROVIDER_LABELS[provider]}.`
        );
        return false;
      }
    },
    [refresh]
  );

  const saveProvider = useCallback(
    async (providerArg?: SelectableProvider | null, model = selectedModel) => {
      const provider = providerArg ?? selectedProvider;
      if (provider === null) {
        setError("Choose an AI provider first.");
        return false;
      }
      const option = snapshot?.providers.find((item) => item.id === provider);
      const subscription = provider === "chatgpt" || provider === "grok";
      if (subscription && !model) {
        setError(`Choose a model for ${option?.label ?? "this connection"}.`);
        return false;
      }
      setSaving(true);
      setError(null);
      try {
        const response = await fetch("/api/ai/settings", {
          body: JSON.stringify({
            provider,
            ...(subscription && model ? { model } : {}),
          }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        const body = await readBody(response);
        if (!response.ok) {
          throw new Error(
            errorMessage(
              body,
              `Couldn't save ${PROVIDER_LABELS[provider]} as the default connection.`,
              provider,
              response.status
            )
          );
        }
        const next = parseSnapshot(body);
        setSnapshot(next);
        setSelectedProvider(next.provider);
        setSelectedModel(next.model ?? null);
        draftSelectionRef.current = false;
        setOnboardingDismissed(false);
        return true;
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : `Couldn't save ${PROVIDER_LABELS[provider]} as the default connection.`
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [selectedModel, selectedProvider, snapshot]
  );

  const dismissOnboarding = useCallback(() => setOnboardingDismissed(true), []);
  const onboardingOpen = Boolean(
    snapshot &&
      snapshot.provider === null &&
      !snapshot.onboardingCompleted &&
      !onboardingDismissed &&
      !loading
  );

  const value = useMemo<AiConnectionContextValue>(
    () => ({
      activeAttempt,
      cancelSubscription,
      connecting,
      connectionError,
      disconnect,
      dismissOnboarding,
      error,
      loading,
      onboardingOpen,
      refresh,
      saveProvider,
      saving,
      selectedModel,
      selectedProvider,
      selectModel,
      selectProvider,
      snapshot,
      startSubscription,
    }),
    [
      activeAttempt,
      cancelSubscription,
      connectionError,
      connecting,
      dismissOnboarding,
      disconnect,
      error,
      loading,
      onboardingOpen,
      refresh,
      saveProvider,
      saving,
      selectedModel,
      selectedProvider,
      selectModel,
      selectProvider,
      snapshot,
      startSubscription,
    ]
  );

  return <AiConnectionContext value={value}>{children}</AiConnectionContext>;
}

export function useAiConnectionOptional() {
  return use(AiConnectionContext);
}

export function useAiConnection() {
  const context = useAiConnectionOptional();
  if (!context) {
    throw new Error("AiConnectionProvider is missing");
  }
  return context;
}
