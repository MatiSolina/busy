import { describe, expect, it, vi } from "vitest";
import { setFunctionMemory } from "./client";

const cfg = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  teamId: "team_1",
  token: "token",
});

describe("bot function memory", () => {
  it("leaves the project alone unless a known type is set", async () => {
    const fetchImpl = vi.fn();
    await setFunctionMemory(cfg(fetchImpl), "bot-a", undefined);
    await setFunctionMemory(cfg(fetchImpl), "bot-a", "huge");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sets the project's default function memory", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}")));
    await setFunctionMemory(
      cfg(fetchImpl as unknown as typeof fetch),
      "bot-a",
      "performance"
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.vercel.com/v9/projects/bot-a?teamId=team_1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      resourceConfig: { functionDefaultMemoryType: "performance" },
    });
  });

  it("fails the deploy step when Vercel rejects it", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("plan", { status: 403 }))
    );
    await expect(
      setFunctionMemory(
        cfg(fetchImpl as unknown as typeof fetch),
        "bot-a",
        "standard"
      )
    ).rejects.toThrow("Vercel set function memory failed: 403");
  });
});
