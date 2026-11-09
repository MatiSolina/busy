import { describe, expect, it } from "vitest";
import { isConsultation } from "./caller";

const app = (principalId: string) => ({
  current: { principalId, principalType: "app" },
});

describe("isConsultation", () => {
  it("is true when another bot calls", () => {
    expect(
      isConsultation(
        app("owner:mati-solina:project:bot-lawyer:environment:production")
      )
    ).toBe(true);
  });

  it("is false for the hub", () => {
    expect(
      isConsultation(
        app("owner:mati-solina:project:busy-hub:environment:production")
      )
    ).toBe(false);
  });

  it("is false with no caller", () => {
    expect(isConsultation({ current: null })).toBe(false);
    expect(isConsultation(undefined)).toBe(false);
  });
});
