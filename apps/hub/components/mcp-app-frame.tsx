"use client";

import type { MCPAppResource } from "@ai-sdk/mcp";
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiRequestDisplayModeResult,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";

interface Implementation {
  name: string;
  version: string;
}

// MCP resource metadata may request browser capabilities, but Busy does not
// grant them to untrusted app content. A future explicit permission flow can
// replace this policy without changing the bridge contract.
const DENIED_BROWSER_PERMISSIONS =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolResult(
  value: unknown
): Parameters<AppBridge["sendToolResult"]>[0] {
  if (isRecord(value) && Array.isArray(value.content)) {
    return value as Parameters<AppBridge["sendToolResult"]>[0];
  }
  return {
    content: [],
    structuredContent: isRecord(value) ? value : { value },
  } as Parameters<AppBridge["sendToolResult"]>[0];
}

export function McpAppFrame({
  hostContext,
  input,
  onCallTool,
  onMessage,
  onOpenLink,
  onRequestDisplayMode,
  onError,
  resource,
  result,
  sandboxUrl,
  className,
  style,
  title,
}: {
  className?: string;
  hostContext: McpUiHostContext;
  input?: unknown;
  onCallTool: (
    params: Parameters<NonNullable<AppBridge["oncalltool"]>>[0]
  ) => Promise<unknown>;
  onMessage: (
    params: Parameters<NonNullable<AppBridge["onmessage"]>>[0]
  ) => Promise<{ isError?: boolean; [key: string]: unknown }>;
  onOpenLink: (
    params: Parameters<NonNullable<AppBridge["onopenlink"]>>[0]
  ) => Promise<{ isError?: boolean; [key: string]: unknown }>;
  onRequestDisplayMode: (
    params: Parameters<NonNullable<AppBridge["onrequestdisplaymode"]>>[0]
  ) => Promise<McpUiRequestDisplayModeResult>;
  onError?: () => void;
  resource: MCPAppResource;
  result?: unknown;
  sandboxUrl: string;
  style?: CSSProperties;
  title: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const handlersRef = useRef({
    onCallTool,
    onMessage,
    onOpenLink,
    onRequestDisplayMode,
  });
  const hostContextRef = useRef(hostContext);
  const bridgeRef = useRef<AppBridge | null>(null);
  const inputRef = useRef(input);
  const resultRef = useRef(result);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    handlersRef.current = {
      onCallTool,
      onMessage,
      onOpenLink,
      onRequestDisplayMode,
    };
    hostContextRef.current = hostContext;
    inputRef.current = input;
    resultRef.current = result;
    onErrorRef.current = onError;
  }, [
    hostContext,
    input,
    onCallTool,
    onError,
    onMessage,
    onOpenLink,
    onRequestDisplayMode,
    result,
  ]);

  useEffect(() => {
    const iframe = iframeRef.current;
    const targetWindow = iframe?.contentWindow;
    if (!targetWindow) {
      return;
    }

    const hostInfo: Implementation = { name: "Busy", version: "1.0.0" };
    const capabilities: McpUiHostCapabilities = {
      logging: {},
      message: { text: {} },
      openLinks: {},
      sandbox: { permissions: {} },
      serverTools: {},
    };
    const bridge = new AppBridge(null, hostInfo, capabilities, {
      hostContext: hostContextRef.current,
    });
    bridgeRef.current = bridge;
    const transport = new PostMessageTransport(targetWindow, targetWindow);
    const reportError = () => onErrorRef.current?.();
    const initializationTimeout = window.setTimeout(reportError, 15_000);
    bridge.onerror = reportError;
    const onSandboxReady = () => {
      bridge
        .sendSandboxResourceReady({
          csp: resource.meta?.csp,
          html: resource.html,
          sandbox: "allow-scripts allow-forms",
        })
        .catch(reportError);
    };
    bridge.addEventListener("sandboxready", onSandboxReady);
    bridge.oncalltool = async (params) =>
      (await handlersRef.current.onCallTool(params)) as Awaited<
        ReturnType<NonNullable<AppBridge["oncalltool"]>>
      >;
    bridge.onmessage = (params) => handlersRef.current.onMessage(params);
    bridge.onopenlink = (params) => handlersRef.current.onOpenLink(params);
    bridge.onrequestdisplaymode = (params) =>
      handlersRef.current.onRequestDisplayMode(params);
    bridge.oninitialized = () => {
      window.clearTimeout(initializationTimeout);
      const argumentsValue = isRecord(inputRef.current) ? inputRef.current : {};
      bridge.sendToolInput({ arguments: argumentsValue }).catch(reportError);
      if (resultRef.current !== undefined) {
        bridge.sendToolResult(toolResult(resultRef.current)).catch(reportError);
      }
    };

    bridge.connect(transport).catch(reportError);
    return () => {
      window.clearTimeout(initializationTimeout);
      bridge.removeEventListener("sandboxready", onSandboxReady);
      if (bridgeRef.current === bridge) {
        bridgeRef.current = null;
      }
      bridge.teardownResource({}).catch(() => undefined);
      transport.close().catch(() => undefined);
    };
  }, [resource.html, resource.meta]);

  useEffect(() => {
    bridgeRef.current?.setHostContext(hostContext);
  }, [hostContext]);

  return (
    <iframe
      allow={DENIED_BROWSER_PERMISSIONS}
      className={className}
      ref={iframeRef}
      sandbox="allow-scripts allow-same-origin allow-forms"
      src={sandboxUrl}
      style={style}
      title={title}
    />
  );
}
