import { beforeEach, describe, expect, it, vi } from "vitest";
import { defined } from "../test-utils";
import memory from "./memory";

const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("../lib/hub", () => ({ hubFetch }));

const capture = defined(
  (
    memory.provider as unknown as {
      capture?: { "turn.completed"?: (ctx: unknown) => Promise<void> };
    }
  ).capture?.["turn.completed"]
);

beforeEach(() => hubFetch.mockReset());

describe("memory provenance", () => {
  it("sends verified Eve session and turn context after fileMemory writes", async () => {
    hubFetch
      .mockResolvedValueOnce(
        Response.json({
          content:
            "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: fact\n",
          version: 4,
        })
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await capture({
      abortSignal: new AbortController().signal,
      session: { auth: { current: { principalId: "hub" } }, id: "session-1" },
      turn: { id: "turn-4" },
    });

    expect(hubFetch).toHaveBeenNthCalledWith(1, "/api/bot/memory", {
      signal: expect.any(AbortSignal),
    });
    const [path, init] = hubFetch.mock.calls[1] ?? [];
    expect(path).toBe("/api/bot/memory");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      content: "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: fact\n",
      sessionId: "session-1",
      turnId: "turn-4",
      version: 4,
    });
  });
});
