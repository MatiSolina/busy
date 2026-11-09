import { describe, expect, it, vi } from "vitest";
import { initialBot } from "@/lib/chat/chat.test-helpers";
import { createChatStore } from "@/lib/chat/client-store";

describe("chat store interaction transport", () => {
  it("sends native option and free-form answers without changing their values", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const store = createChatStore([initialBot("sales")], {
      fetch,
      open: () => {
        throw new Error("not used");
      },
    });

    await store.answer("sales", "approval-1", "approve");
    await store.answer("sales", "question-1", { text: "use November" });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/bots/sales/answer",
      expect.objectContaining({
        body: JSON.stringify({
          interactionId: "approval-1",
          optionId: "approve",
        }),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/bots/sales/answer",
      expect.objectContaining({
        body: JSON.stringify({
          interactionId: "question-1",
          text: "use November",
        }),
      })
    );
  });

  it("reports a transport failure so the card can remain actionable", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 409 }));
    const store = createChatStore([initialBot("sales")], {
      fetch,
      open: () => {
        throw new Error("not used");
      },
    });
    await expect(
      store.answer("sales", "question-1", { text: "retry" })
    ).resolves.toBe(false);
  });
});
