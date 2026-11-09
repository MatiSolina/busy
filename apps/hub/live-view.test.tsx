// @vitest-environment happy-dom
import assert from "node:assert/strict";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  held,
  initialBot,
  installFakes,
  json,
  pane,
  renderApp,
  requested,
  type Server,
  said,
  seq,
  settle,
  started,
} from "./components/components.test-helpers";

const rfb = vi.hoisted(() => {
  const made: {
    password?: string;
    viewOnly: boolean;
    fire: (type: string) => void;
  }[] = [];
  class RFB extends EventTarget {
    viewOnly = false;
    password?: string;

    constructor(
      _target: HTMLElement,
      _url: string,
      options?: { credentials?: { password?: string } }
    ) {
      super();
      this.password = options?.credentials?.password;
      made.push(this);
    }

    fire(type: string) {
      this.dispatchEvent(new Event(type));
    }

    // biome-ignore lint/style/useThisInClassMethods: no-op browser API mock method intentionally ignores receiver.
    // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op browser API mock method intentionally empty.
    disconnect() {}

    // biome-ignore lint/style/useThisInClassMethods: no-op browser API mock method intentionally ignores receiver.
    // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op browser API mock method intentionally empty.
    blur() {}
  }
  return { made, RFB };
});

function madeRfb() {
  const [instance] = rfb.made;
  assert(instance);
  return instance;
}
vi.mock("@novnc/novnc", () => ({ default: rfb.RFB }));
vi.mock("virtua", () => import("@/components/virtua-test-double"));

const LIVE = "/api/bots/lawyer/live";
const target = () =>
  json({
    password: "ctl12345",
    url: "wss://sb-6080.vercel.run/?token=t0k",
    viewOnly: false,
  });
const dialog = () => within(screen.getByRole("dialog"));
const idleBot = () =>
  initialBot("lawyer", { name: "Lawyer", rows: seq(said("d0", "Hi")) });

let server: Server;

beforeEach(() => {
  ({ server } = installFakes());
  rfb.made.length = 0;
  server.on("POST", LIVE, target());
  server.on("PUT", LIVE, json({ expiresAt: Date.now() + 75_000, ok: true }));
  server.on("PATCH", LIVE, (call) =>
    (call.body as { mode: string }).mode === "control"
      ? json({ expiresAt: Date.now() + 75_000, ok: true })
      : json({ ok: true })
  );
});

afterEach(async () => {
  cleanup();
  // Drain the unmount release while the fake fetch is still installed.
  await settle(30);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openLiveSection() {
  fireEvent.click(pane("Lawyer").getByRole("button", { name: "Bot settings" }));
  fireEvent.click(await screen.findByRole("tab", { name: "Live" }));
  await waitFor(() => expect(rfb.made).toHaveLength(1));
}

async function openWatching() {
  renderApp([idleBot()]);
  await settle(30);
  await openLiveSection();
  await settle(20);
  act(() => madeRfb().fire("connect"));
  await settle(10);
}

describe("live control lease", () => {
  it("does not wake a computer until its live view is opened", async () => {
    renderApp([idleBot()]);
    await settle(30);
    expect(server.to("POST", LIVE)).toHaveLength(0);
    expect(rfb.made).toHaveLength(0);
    await openLiveSection();
    await settle(30);
    expect(server.to("POST", LIVE)).toHaveLength(1);
    expect(rfb.made).toHaveLength(1);
  });
  it("keeps noVNC locked until the control lease is acknowledged", async () => {
    const control = held();
    server.on("PATCH", LIVE, (call) =>
      (call.body as { mode: string }).mode === "control"
        ? control.answer()
        : json({ ok: true })
    );
    await openWatching();

    fireEvent.click(dialog().getByRole("button", { name: "Take control" }));
    await settle(10);
    expect(rfb.made[0]).toMatchObject({ password: "ctl12345", viewOnly: true });
    expect(screen.getByTestId("lock")).toBeTruthy();
    expect(dialog().getByRole("status").textContent).toBe(
      "Requesting control…"
    );

    control.resolve(json({ expiresAt: Date.now() + 75_000, ok: true }));
    await settle(20);
    expect(madeRfb().viewOnly).toBe(false);
    expect(screen.queryByTestId("lock")).toBeNull();
    const acquire = server
      .to("PATCH", LIVE)
      .find((c) => (c.body as { mode: string }).mode === "control");
    assert(acquire);
    expect(typeof (acquire.body as { viewerId?: unknown }).viewerId).toBe(
      "string"
    );
  });

  it("shows a busy lease and never enables input", async () => {
    server.on("PATCH", LIVE, (call) => {
      if ((call.body as { mode: string }).mode === "control") {
        return json(
          { code: "CONTROL_BUSY", error: "already held", ok: false },
          409
        );
      }
      return json({ ok: true });
    });
    await openWatching();
    fireEvent.click(dialog().getByRole("button", { name: "Take control" }));
    await settle(20);

    expect(dialog().getByRole("status").textContent).toBe(
      "Another window is controlling this computer."
    );
    expect(dialog().getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByTestId("lock")).toBeTruthy();
    expect(madeRfb().viewOnly).toBe(true);
  });

  it("releases a late acquire after Watch wins the race", async () => {
    const control = held();
    server.on("PATCH", LIVE, (call) =>
      (call.body as { mode: string }).mode === "control"
        ? control.answer()
        : json({ ok: true })
    );
    await openWatching();
    fireEvent.click(dialog().getByRole("button", { name: "Take control" }));
    await settle(10);
    fireEvent.click(dialog().getByRole("button", { name: "Watch" }));
    await settle(5);
    control.resolve(json({ expiresAt: Date.now() + 75_000, ok: true }));
    await settle(30);

    const modes = server
      .to("PATCH", LIVE)
      .map((call) => (call.body as { mode: string }).mode);
    expect(modes).toContain("control");
    expect(
      modes.filter((mode) => mode === "observe").length
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("lock")).toBeTruthy();
    expect(madeRfb().viewOnly).toBe(true);
  });

  it("renews the owner and releases with keepalive on close", async () => {
    await openWatching();
    vi.useFakeTimers();
    fireEvent.click(dialog().getByRole("button", { name: "Take control" }));
    await settle(20);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await settle(10);
    expect(
      server
        .to("PUT", LIVE)
        .some((call) =>
          Boolean((call.body as { viewerId?: string } | undefined)?.viewerId)
        )
    ).toBe(true);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await settle(20);
    const releases = server
      .to("PATCH", LIVE)
      .filter((call) => (call.body as { mode: string }).mode === "observe");
    expect(releases.at(-1)?.init?.keepalive).toBe(true);
  });

  it("releases control when leaving the Live settings section", async () => {
    await openWatching();
    fireEvent.click(dialog().getByRole("button", { name: "Take control" }));
    await settle(20);
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    await settle(20);
    const releases = server
      .to("PATCH", LIVE)
      .filter((call) => (call.body as { mode: string }).mode === "observe");
    expect(releases.at(-1)?.init?.keepalive).toBe(true);
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  it("locks locally when a renewal hangs past the VM lease deadline", async () => {
    const renewal = held();
    server.on("PUT", LIVE, (call) =>
      (call.body as { viewerId?: string } | undefined)?.viewerId
        ? renewal.answer()
        : json({ ok: true })
    );
    await openWatching();
    vi.useFakeTimers();
    fireEvent.click(dialog().getByRole("button", { name: "Take control" }));
    await settle(20);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(74_500);
    });
    await settle(10);
    expect(screen.getByTestId("lock")).toBeTruthy();
    expect(dialog().getByRole("status").textContent).toBe(
      "Control ended. You can keep watching or try again."
    );
  });

  it("releases control before answering a paused login", async () => {
    const loginBot = initialBot("lawyer", {
      name: "Lawyer",
      rows: seq(
        said("d0", "Sign in"),
        started("turn_1"),
        requested("call_1", "request_login"),
        [
          "interaction.opened",
          {
            interactionId: "login_1",
            request: { kind: "question", prompt: "Please sign in" },
            subject: { callId: "call_1" },
          },
        ]
      ),
    });
    server.on("POST", "/api/bots/lawyer/answer", json({ ok: true }));
    renderApp([loginBot]);
    await settle(30);
    fireEvent.click(
      pane("Lawyer").getByRole("button", { name: "Take control" })
    );
    await settle(20);
    act(() => madeRfb().fire("connect"));
    await settle(20);
    fireEvent.click(dialog().getByRole("button", { name: "Done logging in" }));
    await settle(30);

    const releaseIndex = server.calls.findIndex(
      (call) =>
        call.method === "PATCH" &&
        (call.body as { mode: string }).mode === "observe"
    );
    const answerIndex = server.calls.findIndex(
      (call) => call.path === "/api/bots/lawyer/answer"
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(answerIndex).toBeGreaterThan(releaseIndex);
    expect(
      server.calls.filter(
        (call) =>
          call.method === "PATCH" &&
          (call.body as { mode: string }).mode === "control"
      )
    ).toHaveLength(1);
  });
});
