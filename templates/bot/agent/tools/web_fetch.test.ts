import type { SessionView } from "eve/events";
import { webFetch } from "eve/tools/web_fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyResult } from "../lib/lazy-tools";
import { defined } from "../test-utils";
import dynamic, {
  CONSULTATION_WEB_FETCH_DENIED,
  guardedWebFetch,
} from "./web_fetch";

vi.mock("eve/events", async (original) => ({
  ...(await original<typeof import("eve/events")>()),
  calls: () => [],
}));

// A fictitious secret: it must never reach the simulated receiver.
const SECRET_URL = "https://receiver.example.com/collect?secret=fake-s3cr3t";
const human = {
  current: { principalId: "busy-hub:hub", principalType: "service" },
};
const legacyPeer = {
  current: {
    principalId:
      "https://oidc.vercel.com/t:owner:t:project:bot-lawyer:environment:production",
    principalType: "app",
  },
};
const signedPeer = {
  current: {
    principalId: "busy-hub:consultation:11111111-1111-4111-8111-111111111111",
    principalType: "service",
  },
};

interface Executable {
  execute: (input: unknown, ctx: unknown) => Promise<unknown> | unknown;
}
const resolve = (auth: unknown) =>
  (dynamic as unknown as Record<symbol, (ctx: unknown) => unknown>)[
    Symbol.for("eve.dynamic")
  ]?.({ session: { auth }, view: {} as SessionView }) as Executable | null;
const ctx = (auth: unknown) => ({
  abortSignal: new AbortController().signal,
  session: { auth, id: "s" },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web_fetch in consultations (H-07)", () => {
  it("is offered in the user's chat and hidden from both consultation principals", () => {
    expect(resolve(human)).not.toBeNull();
    expect(resolve(legacyPeer)).toBeNull();
    expect(resolve(signedPeer)).toBeNull();
  });

  it.each([
    ["legacy OIDC peer", legacyPeer],
    ["hub-signed consultation", signedPeer],
  ])(
    "rejects a call offered earlier before any request leaves (%s)",
    async (_, peer) => {
      const receiver = vi.fn();
      vi.stubGlobal("fetch", receiver);
      const execute = vi.spyOn(webFetch, "execute");
      // Offered while the user was the caller, executed after the identity changed.
      const offered = defined(resolve(human));
      await expect(
        offered.execute({ url: SECRET_URL }, ctx(peer))
      ).rejects.toThrow(CONSULTATION_WEB_FETCH_DENIED);
      expect(execute).not.toHaveBeenCalled();
      expect(receiver).not.toHaveBeenCalled();
    }
  );

  it("guards the deferred copy that eve__tool calls", async () => {
    const receiver = vi.fn();
    vi.stubGlobal("fetch", receiver);
    const deferred = lazyResult(
      "web",
      {} as SessionView,
      guardedWebFetch,
      true
    ) as unknown as Executable & { deferred?: boolean };
    expect(deferred.deferred).toBe(true);
    await expect(
      deferred.execute({ url: SECRET_URL }, ctx(signedPeer))
    ).rejects.toThrow(CONSULTATION_WEB_FETCH_DENIED);
    expect(receiver).not.toHaveBeenCalled();
  });

  it("still fetches in the user's chat through eve's own implementation", async () => {
    const execute = vi.spyOn(webFetch, "execute").mockResolvedValue({
      content: "ok",
      contentType: "text/plain",
      truncated: false,
      url: "https://example.com",
    } as never);
    const input = { url: "https://example.com" };
    await expect(
      defined(resolve(human)).execute(input, ctx(human))
    ).resolves.toMatchObject({ content: "ok" });
    expect(execute).toHaveBeenCalledWith(input, expect.anything());
  });
});
