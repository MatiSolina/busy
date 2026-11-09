import { describe, expect, it } from "vitest";
import { peerWindow } from "./lib/chat/sync";

// Mirrors the bot's pickPeer (templates/bot/agent/lib/peers.ts): peer-N must resolve to the same
// bot in the hub (consultation target, "answering" badge) as in the bot that called it.
describe("peerWindow", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `b${i + 1}`);

  it("keeps every peer while they fit the 12 slots", () => {
    expect(peerWindow(ids(12))).toEqual(ids(12));
  });

  it("gives the slots to the newest 12, oldest first", () => {
    const window = peerWindow(ids(18));
    expect(window).toHaveLength(12);
    expect(window[0]).toBe("b7");
    expect(window[11]).toBe("b18");
  });
});
