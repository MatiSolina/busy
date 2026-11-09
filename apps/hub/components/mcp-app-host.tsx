"use client";

import type { MCPAppResource } from "@ai-sdk/mcp";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Expand, Loader2, Minimize2, Send, X } from "lucide-react";
import type { FormEvent } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "@/components/chat-app";
import { McpAppFrame } from "@/components/mcp-app-frame";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MAX_MESSAGE_LENGTH = 12_000;
const RESOURCE_RETRY_DELAYS_MS = [100, 300, 600] as const;

interface McpAppDescriptor {
  connectionId: string;
  input?: unknown;
  resourceUri: `ui://${string}`;
  result?: unknown;
  title?: string;
  toolName: string;
}

interface McpAppResourceResponse {
  allowedTools?: string[];
  app: McpAppDescriptor;
  resource: MCPAppResource;
  sandboxUrl: string;
}

interface PendingMessage {
  resolve: (result: MessageResult) => void;
  text: string;
}

interface PendingToolApproval {
  approval: string;
  arguments: Readonly<Record<string, unknown>>;
  expiresAt?: number;
  name: string;
  resolve: (result: unknown) => void;
}

interface MessageResult {
  isError?: boolean;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageText(params: unknown): string {
  if (
    !isRecord(params) ||
    params.role !== "user" ||
    !Array.isArray(params.content)
  ) {
    throw new Error("MCP Apps can only send user text messages.");
  }
  const textBlocks = params.content.filter(
    (block): block is { text: string; type: "text" } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
  );
  if (textBlocks.length !== params.content.length) {
    throw new Error("This chat currently supports text-only MCP App messages.");
  }
  const text = textBlocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
  if (!text) {
    throw new Error("MCP App message is empty.");
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("MCP App messages are limited to 12,000 characters.");
  }
  return text;
}

function toolApprovalDetails(
  body: unknown,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>
): Omit<PendingToolApproval, "resolve"> | null {
  if (
    !isRecord(body) ||
    body.code !== "approval_required" ||
    typeof body.approval !== "string"
  ) {
    return null;
  }
  return {
    approval: body.approval,
    arguments: argumentsValue,
    ...(typeof body.expiresAt === "number"
      ? { expiresAt: body.expiresAt }
      : {}),
    name,
  };
}

function formatToolArguments(
  argumentsValue: Readonly<Record<string, unknown>>
) {
  try {
    return JSON.stringify(argumentsValue, null, 2);
  } catch {
    return "{}";
  }
}

async function requestToolResponse(
  slug: string,
  callId: string,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  approval?: string,
  context?: string
) {
  const response = await fetch(
    `/api/bots/${encodeURIComponent(slug)}/mcp-apps/tool`,
    {
      body: JSON.stringify({
        arguments: argumentsValue,
        callId,
        name,
        ...(context ? { context } : {}),
        ...(approval ? { approval } : {}),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  );
  if (response.status === 409) {
    const body = await response.json().catch(() => null);
    return { body, ok: false, status: response.status };
  }
  if (!response.ok) {
    throw new Error("The MCP App tool call failed.");
  }
  const body = await response.json().catch(() => null);
  return { body, ok: response.ok, status: response.status };
}

async function readResourceResponse(
  response: Response
): Promise<McpAppResourceResponse> {
  if (!response.ok) {
    throw new Error("Couldn't load this MCP App.");
  }
  return (await response.json()) as McpAppResourceResponse;
}

function waitForResourceRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(
        new DOMException(
          "The MCP App resource request was aborted.",
          "AbortError"
        )
      );
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function loadResourceResponse(
  slug: string,
  callId: string,
  signal: AbortSignal,
  attempt = 0,
  context?: string
): Promise<McpAppResourceResponse> {
  const response = await fetch(
    `/api/bots/${encodeURIComponent(slug)}/mcp-apps/resource`,
    {
      body: JSON.stringify({ callId, ...(context ? { context } : {}) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal,
    }
  );
  if (response.status !== 404 || attempt >= RESOURCE_RETRY_DELAYS_MS.length) {
    return readResourceResponse(response);
  }
  await waitForResourceRetry(RESOURCE_RETRY_DELAYS_MS[attempt], signal);
  return loadResourceResponse(slug, callId, signal, attempt + 1, context);
}

function displayModeClass(
  displayMode: "inline" | "fullscreen" | "pip"
): string {
  if (displayMode === "fullscreen") {
    return "fixed inset-0 z-50 bg-background p-4";
  }
  if (displayMode === "pip") {
    return "fixed right-4 bottom-4 z-40 h-[min(32rem,calc(100dvh-2rem))] w-[min(28rem,calc(100vw-2rem))] bg-background shadow-2xl";
  }
  return "border-border bg-background relative h-96 w-full overflow-hidden rounded-xl border";
}

function McpAppHostContent({
  app,
  callTool,
  error,
  hostContext,
  onError,
  onMessage,
  onOpenLink,
  onRequestDisplayMode,
  resource,
  sandboxUrl,
}: {
  app: McpAppDescriptor | null;
  callTool: Parameters<typeof McpAppFrame>[0]["onCallTool"];
  error: string | null;
  hostContext: McpUiHostContext;
  onError: () => void;
  onMessage: Parameters<typeof McpAppFrame>[0]["onMessage"];
  onOpenLink: Parameters<typeof McpAppFrame>[0]["onOpenLink"];
  onRequestDisplayMode: Parameters<
    typeof McpAppFrame
  >[0]["onRequestDisplayMode"];
  resource: MCPAppResource | null;
  sandboxUrl: string | null;
}) {
  if (error) {
    return (
      <p className="text-destructive p-4 text-sm" role="alert">
        {error}
      </p>
    );
  }
  if (app && resource && sandboxUrl) {
    return (
      <div className="min-h-0 flex-1">
        <McpAppFrame
          className="h-full w-full border-0"
          hostContext={hostContext}
          input={app.input}
          onCallTool={callTool}
          onError={onError}
          onMessage={onMessage}
          onOpenLink={onOpenLink}
          onRequestDisplayMode={onRequestDisplayMode}
          resource={resource}
          result={app.result}
          sandboxUrl={sandboxUrl}
          title={app.title ?? "Interactive app"}
        />
      </div>
    );
  }
  return (
    <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      Loading app…
    </div>
  );
}

export function McpAppHost({
  callId,
  context,
  slug,
  toolName,
}: {
  callId: string;
  context?: string;
  slug: string;
  toolName: string;
}) {
  const store = useStore();
  const [app, setApp] = useState<McpAppDescriptor | null>(null);
  const [resource, setResource] = useState<MCPAppResource | null>(null);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [sandboxUrl, setSandboxUrl] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<
    "inline" | "fullscreen" | "pip"
  >("inline");
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(
    null
  );
  const [pendingToolApproval, setPendingToolApproval] =
    useState<PendingToolApproval | null>(null);
  const [toolApprovalError, setToolApprovalError] = useState<string | null>(
    null
  );
  const pendingMessageRef = useRef<PendingMessage | null>(null);
  const pendingToolApprovalRef = useRef<PendingToolApproval | null>(null);
  const hostRef = useRef<HTMLDialogElement>(null);
  const dialogModeRef = useRef<"inline" | "modal" | null>(null);
  const requestKey = `${slug}\u0000${callId}\u0000${toolName}\u0000${context ?? ""}`;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    loadResourceResponse(slug, callId, controller.signal, 0, context)
      .then((body) => {
        if (cancelled) {
          return;
        }
        if (
          !(body?.app && body.resource) ||
          typeof body.sandboxUrl !== "string" ||
          body.app.toolName !== toolName ||
          body.app.resourceUri?.startsWith("ui://") !== true
        ) {
          throw new Error("The MCP App resource response is invalid.");
        }
        const sandbox = new URL(body.sandboxUrl, window.location.href);
        if (sandbox.protocol !== "https:" && sandbox.protocol !== "http:") {
          throw new Error("The MCP App sandbox URL is invalid.");
        }
        if (sandbox.origin === window.location.origin) {
          throw new Error("The MCP App sandbox must use a separate origin.");
        }
        setApp(body.app);
        setResource(body.resource);
        setAllowedTools(body.allowedTools ?? []);
        setSandboxUrl(sandbox.href);
        setError(null);
        setLoadedKey(requestKey);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Couldn't load this MCP App."
          );
          setLoadedKey(requestKey);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [callId, context, requestKey, slug, toolName]);

  const currentApp = loadedKey === requestKey ? app : null;
  const currentResource = loadedKey === requestKey ? resource : null;
  const currentSandboxUrl = loadedKey === requestKey ? sandboxUrl : null;
  const currentError = loadedKey === requestKey ? error : null;

  const callTool = useCallback(
    async (params: { arguments?: Record<string, unknown>; name: string }) => {
      const visibleTools = loadedKey === requestKey ? allowedTools : [];
      if (!visibleTools.includes(params.name)) {
        throw new Error(`Tool is not app-visible: ${params.name}`);
      }
      const argumentsValue = Object.freeze({ ...(params.arguments ?? {}) });
      const { body, ok, status } = await requestToolResponse(
        slug,
        callId,
        params.name,
        argumentsValue,
        undefined,
        context
      );
      if (!ok) {
        const approval =
          status === 409
            ? toolApprovalDetails(body, params.name, argumentsValue)
            : null;
        if (approval) {
          if (pendingToolApprovalRef.current) {
            return { isError: true };
          }
          return new Promise((resolve) => {
            const pending = { ...approval, resolve };
            pendingToolApprovalRef.current = pending;
            setToolApprovalError(null);
            setPendingToolApproval(pending);
          });
        }
        throw new Error("The MCP App tool call failed.");
      }
      return body;
    },
    [allowedTools, callId, context, loadedKey, requestKey, slug]
  );

  const confirmToolApproval = useCallback(async () => {
    const pending = pendingToolApprovalRef.current;
    if (!pending) {
      return;
    }
    pendingToolApprovalRef.current = null;
    setPendingToolApproval(null);
    try {
      const { body, ok } = await requestToolResponse(
        slug,
        callId,
        pending.name,
        pending.arguments,
        pending.approval,
        context
      );
      if (!ok) {
        throw new Error("The MCP App action failed.");
      }
      pending.resolve(body);
    } catch {
      setToolApprovalError("The action could not be completed. Try again.");
      pending.resolve({ isError: true });
    }
  }, [callId, context, slug]);

  const rejectToolApproval = useCallback(() => {
    const pending = pendingToolApprovalRef.current;
    pendingToolApprovalRef.current = null;
    setPendingToolApproval(null);
    setToolApprovalError(null);
    pending?.resolve({ isError: true });
  }, []);

  const sendMessage = useCallback((params: unknown): Promise<MessageResult> => {
    let text: string;
    try {
      text = messageText(params);
    } catch (cause) {
      return Promise.reject(
        cause instanceof Error ? cause : new Error(String(cause))
      );
    }
    if (pendingMessageRef.current) {
      return Promise.resolve({ isError: true });
    }
    return new Promise((resolve) => {
      const pending = {
        resolve,
        text,
      } satisfies PendingMessage;
      pendingMessageRef.current = pending;
      setPendingMessage(pending);
    });
  }, []);

  const confirmMessage = useCallback(async () => {
    const pending = pendingMessageRef.current;
    if (!pending) {
      return;
    }
    pendingMessageRef.current = null;
    setPendingMessage(null);
    try {
      if (context) {
        const [firesideId] = context.split("/");
        const latest = await fetch(`/api/firesides/${firesideId}`);
        if (!latest.ok) {
          throw new Error("Fireside unavailable");
        }
        const room = (await latest.json()) as { revision: number };
        const sent = await fetch(`/api/firesides/${firesideId}`, {
          body: JSON.stringify({
            id: crypto.randomUUID(),
            kind: "intervene",
            revision: room.revision,
            text: pending.text,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!sent.ok) {
          throw new Error("Fireside changed");
        }
      } else {
        await store.send(slug, {
          files: [],
          id: crypto.randomUUID(),
          text: pending.text,
        });
      }
      pending.resolve({});
    } catch {
      pending.resolve({ isError: true });
    }
  }, [context, slug, store]);

  const rejectMessage = useCallback(() => {
    const pending = pendingMessageRef.current;
    pendingMessageRef.current = null;
    setPendingMessage(null);
    pending?.resolve({ isError: true });
  }, []);

  useEffect(
    () => () => {
      pendingMessageRef.current?.resolve({ isError: true });
      pendingMessageRef.current = null;
      pendingToolApprovalRef.current?.resolve({ isError: true });
      pendingToolApprovalRef.current = null;
    },
    []
  );

  const hostContext = useMemo<McpUiHostContext>(
    () => ({
      availableDisplayModes: ["inline", "fullscreen", "pip"],
      displayMode,
      theme: "dark",
    }),
    [displayMode]
  );
  const handleFrameError = useCallback(
    () => setError("This MCP App couldn't start. Try again."),
    []
  );
  useLayoutEffect(() => {
    const dialog = hostRef.current;
    if (
      !(
        dialog &&
        typeof dialog.show === "function" &&
        typeof dialog.showModal === "function"
      )
    ) {
      return;
    }
    if (displayMode === "fullscreen") {
      if (dialogModeRef.current === "modal") {
        return;
      }
      if (dialog.open) {
        dialog.close();
      }
      dialog.showModal();
      dialogModeRef.current = "modal";
      dialog.focus();
      return;
    }
    if (dialogModeRef.current === "inline") {
      return;
    }
    if (dialog.open) {
      dialog.close();
    }
    dialog.show();
    dialogModeRef.current = "inline";
  }, [displayMode]);
  useEffect(() => {
    if (displayMode !== "fullscreen") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDisplayMode("inline");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [displayMode]);
  const handleDialogCancel = useCallback(
    (event: FormEvent<HTMLDialogElement>) => {
      event.preventDefault();
      setDisplayMode("inline");
    },
    []
  );
  const openLink = useCallback(({ url }: { url: string }) => {
    const destination = URL.parse(url);
    if (
      !(
        destination &&
        ["https:", "http:", "mailto:"].includes(destination.protocol)
      )
    ) {
      return Promise.reject(new Error("This app link is not supported."));
    }
    window.open(destination.href, "_blank", "noopener,noreferrer");
    return Promise.resolve({});
  }, []);
  const requestDisplayMode = useCallback(
    ({ mode }: { mode: "inline" | "fullscreen" | "pip" }) => {
      setDisplayMode(mode);
      return Promise.resolve({ mode });
    },
    []
  );

  const hostClass = displayModeClass(displayMode);
  const appTitle = currentApp?.title ?? "Interactive app";
  const enterFullscreen = useCallback(() => setDisplayMode("fullscreen"), []);
  const exitDisplayMode = useCallback(() => setDisplayMode("inline"), []);

  return (
    <dialog
      aria-label={appTitle}
      aria-modal={displayMode === "fullscreen" ? "true" : undefined}
      className={cn(
        "m-0 max-h-none max-w-none border-0 bg-transparent p-0",
        hostClass,
        "flex min-h-0 flex-col"
      )}
      onCancel={handleDialogCancel}
      ref={hostRef}
      tabIndex={-1}
    >
      <div className="border-border text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="min-w-0 flex-1 truncate">{appTitle}</span>
        {displayMode === "fullscreen" ? (
          <Button
            aria-label="Exit fullscreen"
            onClick={exitDisplayMode}
            size="icon-xs"
            variant="ghost"
          >
            <Minimize2 aria-hidden="true" />
          </Button>
        ) : (
          <Button
            aria-label="Open fullscreen"
            onClick={enterFullscreen}
            size="icon-xs"
            variant="ghost"
          >
            <Expand aria-hidden="true" />
          </Button>
        )}
        {displayMode === "pip" ? (
          <Button
            aria-label="Close picture in picture"
            onClick={exitDisplayMode}
            size="icon-xs"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <McpAppHostContent
        app={currentApp}
        callTool={callTool}
        error={currentError}
        hostContext={hostContext}
        onError={handleFrameError}
        onMessage={sendMessage}
        onOpenLink={openLink}
        onRequestDisplayMode={requestDisplayMode}
        resource={currentResource}
        sandboxUrl={currentSandboxUrl}
      />
      {pendingToolApproval ? (
        <div className="border-border bg-background/95 absolute right-3 bottom-3 left-3 z-10 rounded-lg border p-3 shadow-xl backdrop-blur">
          <p className="text-muted-foreground text-xs">
            This app wants to run an action:
          </p>
          <p className="mt-1 text-sm font-medium">{pendingToolApproval.name}</p>
          <pre className="bg-muted/50 mt-2 max-h-32 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
            {formatToolArguments(pendingToolApproval.arguments)}
          </pre>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={rejectToolApproval} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button onClick={confirmToolApproval} size="sm">
              Approve and run
            </Button>
          </div>
        </div>
      ) : null}
      {toolApprovalError ? (
        <p
          className="text-destructive bg-background/95 absolute right-3 bottom-3 left-3 z-10 rounded-md p-3 text-sm shadow-xl"
          role="alert"
        >
          {toolApprovalError}
        </p>
      ) : null}
      {pendingMessage ? (
        <div className="border-border bg-background/95 absolute right-3 bottom-3 left-3 z-10 rounded-lg border p-3 shadow-xl backdrop-blur">
          <p className="text-muted-foreground text-xs">
            This app wants to send a message to the chat:
          </p>
          <p className="mt-1 max-h-32 overflow-auto text-sm whitespace-pre-wrap">
            {pendingMessage.text}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={rejectMessage} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button onClick={confirmMessage} size="sm">
              <Send aria-hidden="true" />
              Send message
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

export type { McpAppDescriptor };
