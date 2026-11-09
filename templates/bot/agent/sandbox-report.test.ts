import { beforeEach, describe, expect, it, vi } from "vitest";
import selector from "./sandbox";

// The selector reports eve's public sandbox name to the hub (H-18). Stand-ins as in sandbox.test.ts.
const h = vi.hoisted(() => ({
  open: vi.fn(),
  reportComputer: vi.fn(),
  states: new Map<string, unknown>(),
}));
vi.mock("eve/context", () => ({
  defineState: (name: string, init: () => unknown) => ({
    get: () => (h.states.has(name) ? h.states.get(name) : init()),
    update: (fn: (v: unknown) => unknown) =>
      h.states.set(name, fn(h.states.has(name) ? h.states.get(name) : init())),
  }),
}));
vi.mock("eve/sandbox/vercel", () => ({
  VercelSandbox: {
    environment: () => ({ open: (...args: unknown[]) => h.open(...args) }),
  },
}));
vi.mock("@vercel/sandbox", () => ({
  Drive: {
    getOrCreate: async ({ name }: { name: string }) => ({
      name,
      snapshot: async () => ({ drive: name, mode: "snapshot" }),
    }),
  },
}));
vi.mock("./lib/computer", () => ({ reportComputer: h.reportComputer }));

const open = selector as unknown as (ctx: unknown) => Promise<unknown>;
const session = (id: string, principalId: string) => ({
  session: {
    auth: {
      current: { principalId, principalType: "service" },
      initiator: null,
    },
    id,
  },
});
const NAME = "eve-sbx-vercel-0123456789abcdef0123456789abcdef";

beforeEach(() => {
  h.states.clear();
  h.open.mockReset().mockResolvedValue({ name: NAME });
  h.reportComputer.mockReset().mockResolvedValue(undefined);
});

describe("the sandbox name handshake", () => {
  it("reports the chat's real sandbox name with its session", async () => {
    await open(session("chat", "busy-hub:hub"));
    expect(h.reportComputer).toHaveBeenCalledWith("chat", NAME);
  });

  it("never reports a consultation's computer", async () => {
    await open(
      session(
        "q1",
        "https://oidc.vercel.com/mati-solina:owner:mati-solina:project:bot-lawyer:environment:production"
      )
    );
    expect(h.reportComputer).not.toHaveBeenCalled();
  });

  it("opens the computer even when the report fails", async () => {
    h.reportComputer.mockRejectedValue(new Error("hub down"));
    await expect(open(session("chat", "busy-hub:hub"))).resolves.toEqual({
      name: NAME,
    });
  });
});
