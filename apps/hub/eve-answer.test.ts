import { describe, expect, it, vi } from "vitest";
import { answerInteraction, type BotCall } from "@/lib/eve/client";

const call = (status: number, body = "") => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(body, { status }));
  const bot: BotCall = {
    fetchImpl,
    token: async () => "token",
    url: "https://sales.example",
  };
  return { bot, fetchImpl };
};

describe("eve answer transport", () => {
  it("keeps option answers in the native answers envelope", async () => {
    const { bot, fetchImpl } = call(200, "{}");
    await answerInteraction(bot, "session-1", {
      interactionId: "q-1",
      optionId: "xlsx",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sales.example/eve/v1/session/session-1",
      expect.objectContaining({
        body: JSON.stringify({
          answers: [{ interactionId: "q-1", optionId: "xlsx" }],
        }),
      })
    );
  });

  it("keeps free-form answers in the native answers envelope", async () => {
    const { bot, fetchImpl } = call(200, "{}");
    await answerInteraction(bot, "session-1", {
      interactionId: "q-1",
      text: "use November",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sales.example/eve/v1/session/session-1",
      expect.objectContaining({
        body: JSON.stringify({
          answers: [{ interactionId: "q-1", text: "use November" }],
        }),
      })
    );
  });

  it("surfaces non-2xx eve responses", async () => {
    const { bot } = call(409, "stale interaction");
    await expect(
      answerInteraction(bot, "session-1", {
        interactionId: "q-1",
        optionId: "xlsx",
      })
    ).rejects.toThrow("eve answer failed: 409 stale interaction");
  });
});
