// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAppHost } from "./mcp-app-host";

interface MockFrameProps {
  onCallTool: (params: {
    arguments?: Record<string, unknown>;
    name: string;
  }) => Promise<unknown>;
  onMessage: (params: unknown) => Promise<unknown>;
  onOpenLink: (params: { url: string }) => Promise<unknown>;
  title: string;
}

const store = vi.hoisted(() => ({ send: vi.fn() }));
const frameState = vi.hoisted(() => ({
  props: null as MockFrameProps | null,
}));

vi.mock("@/components/chat-app", () => ({ useStore: () => store }));
vi.mock("./mcp-app-frame", () => ({
  McpAppFrame: (props: MockFrameProps) => {
    frameState.props = props;
    return <div data-testid="mcp-app-frame" title={props.title} />;
  },
}));

const sandboxOrigin = "https://sandbox.example.test";
const MESSAGE_ARGUMENT_PATTERN = /"message": "hello"/u;
const resourceResponse = {
  allowedTools: ["read_dashboard", "write_message"],
  app: {
    callId: "call-1",
    connectionId: "connection-1",
    input: { dashboard: "usage" },
    resourceUri: "ui://example/dashboard",
    result: { content: [{ text: "Ready", type: "text" }] },
    title: "Usage dashboard",
    toolName: "show_dashboard",
  },
  resource: {
    html: "<main>Usage</main>",
    meta: {
      permissions: {
        camera: {},
        clipboardWrite: {},
        geolocation: {},
        microphone: {},
      },
    },
    mimeType: "text/html;profile=mcp-app",
    uri: "ui://example/dashboard",
  },
  sandboxUrl: `${sandboxOrigin}/mcp-app-sandbox`,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  frameState.props = null;
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/mcp-apps/resource")) {
      return Promise.resolve(Response.json(resourceResponse));
    }
    if (url.endsWith("/mcp-apps/tool")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        approval?: string;
        name?: string;
      };
      if (body.name === "write_message" && !body.approval) {
        return Promise.resolve(
          Response.json(
            {
              approval: "approval-token",
              code: "approval_required",
              expiresAt: Date.now() + 60_000,
            },
            { status: 409 }
          )
        );
      }
      return Promise.resolve(
        Response.json({ content: [{ text: "Tool result", type: "text" }] })
      );
    }
    return Promise.resolve(
      Response.json({ error: "not found" }, { status: 404 })
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  store.send.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function appFrame() {
  const frame = await screen.findByTitle("Usage dashboard");
  return frame;
}

async function dispatchAppMessage(data: unknown) {
  await act(async () => {
    const messagePromise = frameState.props?.onMessage(data);
    messagePromise?.catch(() => undefined);
    await Promise.resolve();
  });
}

async function dispatchToolCall(
  name: string,
  argumentsValue: Record<string, unknown>
) {
  await act(async () => {
    const toolPromise = frameState.props?.onCallTool({
      arguments: argumentsValue,
      name,
    });
    toolPromise?.catch(() => undefined);
    await Promise.resolve();
  });
}

describe("MCP App host", () => {
  it("opens web links safely and rejects executable link schemes", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    await appFrame();
    await expect(
      frameState.props?.onOpenLink({ url: "javascript:alert(1)" })
    ).rejects.toThrow("not supported");
    await expect(
      frameState.props?.onOpenLink({ url: "data:text/html,example" })
    ).rejects.toThrow("not supported");
    expect(open).not.toHaveBeenCalled();
    await frameState.props?.onOpenLink({
      url: "https://example.com/deployment",
    });
    expect(open).toHaveBeenCalledWith(
      "https://example.com/deployment",
      "_blank",
      "noopener,noreferrer"
    );
  });
  it("keeps the app iframe mounted in fullscreen and exits with Escape", async () => {
    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    const frame = await appFrame();
    fireEvent.click(screen.getByRole("button", { name: "Open fullscreen" }));
    expect(
      screen.getByRole("button", { name: "Exit fullscreen" })
    ).toBeTruthy();
    expect(
      screen
        .getByRole("dialog", { name: "Usage dashboard" })
        .getAttribute("aria-modal")
    ).toBe("true");
    expect(screen.getByTitle("Usage dashboard")).toBe(frame);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "Open fullscreen" })
    ).toBeTruthy();
  });

  it("confirms ui/message before sending a real chat delivery", async () => {
    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    await appFrame();
    await dispatchAppMessage({
      content: [
        { text: "Send the selected dashboard to the chat.", type: "text" },
      ],
      role: "user",
    });

    expect(
      await screen.findByText("Send the selected dashboard to the chat.")
    ).toBeTruthy();
    expect(store.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(store.send).toHaveBeenCalledWith("builder", {
        files: [],
        id: expect.any(String),
        text: "Send the selected dashboard to the chat.",
      })
    );
  });

  it("rejects unsupported ui/message content without exposing it to the chat", async () => {
    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    await appFrame();
    await dispatchAppMessage({
      content: [{ data: "data:image/png;base64,abc", type: "image" }],
      role: "user",
    });
    await act(async () => Promise.resolve());
    expect(
      screen.queryByText("This app wants to send a message to the chat:")
    ).toBeNull();
    expect(store.send).not.toHaveBeenCalled();
  });

  it("proxies only allow-listed read tools through the host route", async () => {
    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    await appFrame();
    await dispatchToolCall("read_dashboard", { dashboard: "usage" });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/bots/builder/mcp-apps/tool",
        expect.objectContaining({
          body: JSON.stringify({
            arguments: { dashboard: "usage" },
            callId: "call-1",
            name: "read_dashboard",
          }),
        })
      )
    );
  });

  it("previews a write and only retries it after explicit approval", async () => {
    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    await appFrame();
    await dispatchToolCall("write_message", { message: "hello" });

    expect(await screen.findByText("write_message")).toBeTruthy();
    expect(screen.getByText(MESSAGE_ARGUMENT_PATTERN)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1);
      const lastInit = lastCall?.[1] as RequestInit | undefined;
      expect(JSON.parse(String(lastInit?.body))).toEqual({
        approval: "approval-token",
        arguments: { message: "hello" },
        callId: "call-1",
        name: "write_message",
      });
    });
  });

  it("resolves a rejected write without retrying it", async () => {
    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    await appFrame();
    await dispatchToolCall("write_message", { message: "cancel me" });

    expect(await screen.findByText("write_message")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient resource miss before showing an error", async () => {
    let resourceAttempts = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith("/mcp-apps/resource")) {
        resourceAttempts += 1;
        if (resourceAttempts < 3) {
          return Promise.resolve(
            Response.json({ error: "not committed yet" }, { status: 404 })
          );
        }
      }
      return Promise.resolve(Response.json(resourceResponse));
    });

    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    await appFrame();
    expect(resourceAttempts).toBe(3);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rejects a same-origin sandbox response visibly", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...resourceResponse,
        sandboxUrl: "/mcp-app-sandbox",
      })
    );
    render(
      <McpAppHost callId="call-1" slug="builder" toolName="show_dashboard" />
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "separate origin"
    );
  });
});
