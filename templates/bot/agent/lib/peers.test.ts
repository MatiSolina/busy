import { describe, expect, it } from "vitest";
import { formatDirectory, type Peer, pickPeer } from "./peers";

const a: Peer = {
  description: "Contracts.",
  name: "Lawyer DNC",
  slug: "lawyer",
  url: "https://lawyer.bots.matisolina.com",
};
const b: Peer = {
  description: "Quotes.",
  name: "Sales DNC",
  slug: "sales",
  url: "https://sales.bots.matisolina.com",
};

describe("pickPeer", () => {
  it("is 1-based and null past the end", () => {
    expect(pickPeer([a, b], 1)).toBe(a);
    expect(pickPeer([a, b], 2)).toBe(b);
    expect(pickPeer([a, b], 3)).toBeNull();
    expect(pickPeer([], 1)).toBeNull();
  });
});

describe("formatDirectory", () => {
  it("lists each peer with its consult tool", () => {
    const text = formatDirectory([a, b]);
    expect(text).toContain("<bot_directory>");
    expect(text).toContain("Lawyer DNC (tool peer-1): Contracts.");
    expect(text).toContain("Sales DNC (tool peer-2): Quotes.");
  });

  it("says so when there are no peers", () => {
    expect(formatDirectory([])).toContain("No other bots");
  });
});
