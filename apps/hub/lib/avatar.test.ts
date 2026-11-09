import { describe, expect, it } from "vitest";
import {
  avatarFor,
  PIX_KEYS,
  PIX_VARIANTS,
  pixFor,
  variantFor,
} from "@/lib/avatar";

describe("bot avatar identities", () => {
  it("keeps every simple Pix color", () => {
    for (const color of PIX_KEYS) {
      expect(pixFor("ignored", color)).toBe(color);
    }
  });

  it("keeps colors from the previous icon-coded avatar values", () => {
    expect(pixFor("ignored", "code:violet")).toBe("violet");
    expect(pixFor("ignored", "briefcase:orange")).toBe("orange");
    expect(pixFor("ignored", "robot:lime")).toBe("lime");
  });

  it("uses the stable slug hash for unknown avatar values", () => {
    expect(pixFor("new-bot", "unknown")).toBe("lavender");
    expect(pixFor("lawyer", "unknown:invalid")).toBe("orange");
    expect(pixFor("lawyer", null)).toBe("orange");
  });

  it("keeps the legacy slug fallback order stable", () => {
    expect(PIX_KEYS).toEqual([
      "lime",
      "green",
      "violet",
      "purple",
      "red",
      "orange",
      "sand",
      "cream",
      "white",
      "lavender",
      "brown",
      "night",
    ]);
    expect(
      ["new-bot", "lawyer", "research-desk", "ops-desk"].map((slug) =>
        pixFor(slug)
      )
    ).toEqual(["lavender", "orange", "sand", "cream"]);
    expect(pixFor("lawyer", "legacy-unknown")).toBe(pixFor("lawyer"));
  });

  it("round-trips every shipped themed identity", () => {
    for (const variant of PIX_VARIANTS) {
      const avatar = avatarFor(variant.color, variant.id);
      expect(variantFor(avatar)).toBe(variant.id);
      expect(pixFor("ignored", avatar)).toBe(variant.color);
    }
  });

  it("keeps classic identities as their legacy color strings", () => {
    expect(avatarFor("orange", "classic")).toBe("orange");
    expect(variantFor("orange")).toBe("classic");
    expect(variantFor(undefined)).toBe("classic");
    expect(variantFor(null)).toBe("classic");
  });

  it("does not opt malformed or unknown colon values into a costume", () => {
    expect(variantFor("pix:pop:not-a-color")).toBe("classic");
    expect(variantFor("pix:unknown:orange")).toBe("classic");
    expect(variantFor("pix:pop:orange:extra")).toBe("classic");
    expect(variantFor("code:violet")).toBe("classic");
    expect(pixFor("ignored", "pix:pop:orange")).toBe("orange");
  });
});
