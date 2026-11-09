import { describe, expect, it } from "vitest";
import {
  callSettled,
  consumed,
  requested,
  seq,
  started,
} from "./chat.test-helpers";
import { toChatView } from "./items";

const view = (...rows: Parameters<typeof seq>) =>
  toChatView(seq(...rows), new Map(), new Map()).items;

describe("the bot's reaction on the user's message", () => {
  it("lands on the latest user message, and a later one replaces it", () => {
    const items = view(
      consumed("first", [{ kind: "text", text: "hi" }]),
      consumed("second", [{ kind: "text", text: "thanks!" }]),
      started("turn-1"),
      requested("r1", "react", { emoji: "👍" }),
      callSettled("r1", "completed"),
      requested("r2", "react", { emoji: "❤️" }),
      callSettled("r2", "completed")
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "user", text: "hi" }),
      expect.objectContaining({ kind: "user", reaction: "❤️", text: "thanks!" }),
    ]);
    expect(items[0]).not.toHaveProperty("reaction");
  });

  it("ignores an emoji outside the set and shows no activity for the call", () => {
    const items = view(
      consumed("m", [{ kind: "text", text: "ok" }]),
      started("turn-1"),
      requested("r", "react", { emoji: "💩" }),
      callSettled("r", "completed")
    );
    expect(items).toEqual([
      expect.not.objectContaining({ reaction: expect.anything() }),
    ]);
  });
});

describe("ask_user", () => {
  it("shows only its question card, not an activity row", () => {
    const items = view(
      consumed("m", [{ kind: "text", text: "summary please" }]),
      started("turn-1"),
      requested("q1", "ask_user", { options: [], question: "Which?" })
    );
    expect(items.some((i) => i.kind === "activity")).toBe(false);
  });
});
