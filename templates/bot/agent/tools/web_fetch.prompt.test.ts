import { describe, expect, it, vi } from "vitest";

const page = {
  content: "x".repeat(40_000),
  contentType: "text/markdown",
  truncated: false,
  url: "https://example.com",
};
vi.mock("eve/tools/web_fetch", () => ({
  webFetch: {
    description: "Fetch a webpage.",
    execute: vi.fn(async () => page),
    label: { start: () => "Fetch" },
  },
}));
const generateText = vi.fn(async (_options: { prompt: string }) => ({
  text: "Founded in 2019.",
}));
vi.mock("ai", () => ({ generateText }));

const { guardedWebFetch: tool } = await import("./web_fetch");
type Exec = (input: object, ctx: object) => Promise<unknown>;
const { execute } = tool as unknown as { execute: Exec };
const ctx = {
  abortSignal: undefined,
  session: {
    auth: {
      current: { principalId: "busy-hub:hub", principalType: "service" },
    },
    id: "s1",
  },
};

describe("web_fetch with a prompt", () => {
  it("returns the page unchanged without a prompt", async () => {
    expect(await execute({ url: page.url }, ctx)).toBe(page);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns only the model's answer with a prompt", async () => {
    const result = await execute(
      { prompt: "When was it founded?", url: page.url },
      ctx
    );
    expect(result).toEqual({ answer: "Founded in 2019.", url: page.url });
    const sent = generateText.mock.calls[0]?.[0].prompt ?? "";
    expect(sent).toContain("When was it founded?");
    expect(sent).toContain(page.content);
  });
});
