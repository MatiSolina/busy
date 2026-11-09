import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ compactSession: vi.fn(), getBot: vi.fn() }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/store", () => ({ botCall: (slug: string) => ({ slug }) }));
vi.mock("@/lib/eve/client", () => ({ compactSession: mocks.compactSession }));

const { POST } = await import("@/app/api/bots/[slug]/compact/route");
const ctx = { params: Promise.resolve({ slug: "lawyer" }) };
const req = () =>
  new Request("http://hub/api/bots/lawyer/compact", { method: "POST" });

beforeEach(() => {
  mocks.compactSession.mockReset();
  mocks.getBot.mockReset();
});

describe("POST /api/bots/[slug]/compact", () => {
  it("compacts the bot's chat session", async () => {
    mocks.getBot.mockResolvedValue({
      sessionId: "s1",
      slug: "lawyer",
      status: "ready",
    });
    mocks.compactSession.mockResolvedValue(undefined);
    expect((await POST(req(), ctx)).status).toBe(202);
    expect(mocks.compactSession).toHaveBeenCalledWith({ slug: "lawyer" }, "s1");
  });

  it("refuses without a session and hides eve's error", async () => {
    mocks.getBot.mockResolvedValue({
      sessionId: null,
      slug: "lawyer",
      status: "ready",
    });
    expect((await POST(req(), ctx)).status).toBe(409);
    mocks.getBot.mockResolvedValue({
      sessionId: "s1",
      slug: "lawyer",
      status: "ready",
    });
    mocks.compactSession.mockRejectedValue(
      new Error("eve compact failed: secret")
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret");
  });
});
