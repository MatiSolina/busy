import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bot/files/route";

const mocks = vi.hoisted(() => ({
  botFromRequest: vi.fn(),
  chatFiles: vi.fn(),
  getBot: vi.fn(),
  linkFileProvenance: vi.fn(),
  registerFile: vi.fn(),
}));

vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.botFromRequest }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/files", () => ({
  chatFiles: mocks.chatFiles,
  fileInput: { maxBytes: 200 * 1024 * 1024, maxNameLength: 200 },
  isBotUnavailable: () => false,
  registerFile: mocks.registerFile,
}));
vi.mock("@/lib/library-objects", () => ({
  linkFileProvenance: mocks.linkFileProvenance,
}));

const bot = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "session-1",
  slug: "assistant",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.botFromRequest.mockResolvedValue({ slug: bot.slug });
  mocks.getBot.mockResolvedValue(bot);
  mocks.registerFile.mockResolvedValue({
    fileId: "22222222-2222-4222-8222-222222222222",
    uploadUrl: "https://blob.example/upload",
  });
  mocks.linkFileProvenance.mockResolvedValue(true);
});

const request = (body: unknown) =>
  new Request("https://busy.test/api/bot/files", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

describe("bot file reservation safety", () => {
  it("rejects a credential-like filename before reserving or uploading", async () => {
    const response = await POST(
      request({
        contentType: "application/json",
        name: "credentials.json",
        size: 128,
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "This file cannot be delivered because it may contain credentials.",
    });
    expect(mocks.registerFile).not.toHaveBeenCalled();
    expect(mocks.linkFileProvenance).not.toHaveBeenCalled();
  });

  it("keeps ordinary bot artifacts on the existing reservation path", async () => {
    const response = await POST(
      request({ contentType: "application/pdf", name: "report.pdf", size: 128 })
    );

    expect(response.status).toBe(200);
    expect(mocks.registerFile).toHaveBeenCalledWith(
      bot,
      { contentType: "application/pdf", name: "report.pdf", size: 128 },
      "bot"
    );
    expect(mocks.linkFileProvenance).toHaveBeenCalledWith(
      bot.id,
      "22222222-2222-4222-8222-222222222222",
      { sessionId: null }
    );
  });
});
