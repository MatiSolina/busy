import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metric = vi.hoisted(() => vi.fn());
vi.mock("@vercel/functions", () => ({ metric }));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("https://hub.test/api/rum", {
      body: typeof body === "string" ? body : JSON.stringify(body),
      method: "POST",
    })
  );

describe("POST /api/rum", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_RUM", "1");
    metric.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("emits allowlisted numeric samples and logs them without content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const res = await post({
      samples: [
        { name: "chat.ttft", value: 812 },
        { name: "chat.send_ack", value: 95 },
        { name: "chat.secret", value: 1 },
        { name: "chat.ttft", value: -1 },
        { name: "chat.ttft", value: 10_000_000 },
        { name: "chat.ttft", value: "812" },
        { name: "chat.ttft", text: "hello", value: 700 },
      ],
    });
    expect(res.status).toBe(204);
    expect(metric.mock.calls).toEqual([
      ["chat.ttft_ms", 812],
      ["chat.send_ack_ms", 95],
      ["chat.ttft_ms", 700],
    ]);
    const logged = info.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual({
      event: "chat.rum",
      source: "busy.chat",
      ttftMs: 812,
    });
    expect(JSON.stringify(logged)).not.toContain("hello");
    info.mockRestore();
  });

  it("rejects malformed or oversized bodies and is off without the flag", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ samples: "x" })).status).toBe(400);
    expect((await post("x".repeat(5000))).status).toBe(413);
    vi.stubEnv("NEXT_PUBLIC_RUM", "");
    expect(
      (await post({ samples: [{ name: "chat.ttft", value: 1 }] })).status
    ).toBe(204);
    expect(metric).not.toHaveBeenCalled();
  });
});
