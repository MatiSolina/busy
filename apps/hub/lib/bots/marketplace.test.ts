import { describe, expect, it } from "vitest";
import { avatarFor, PIX_KEYS, pixFor, variantFor } from "@/lib/avatar";
import {
  BOT_CATEGORIES,
  BOT_TEMPLATES,
  botTemplate,
  FEATURED_BOT_TEMPLATES,
  searchBotTemplates,
} from "@/lib/bots/marketplace";

const EXPLICIT_APPROVAL_PATTERN = /explicit approval/iu;

describe("bot marketplace catalog", () => {
  it("contains a complete, bounded template for every category", () => {
    expect(BOT_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(BOT_TEMPLATES.map((template) => template.id)).size).toBe(
      BOT_TEMPLATES.length
    );
    expect(new Set(BOT_TEMPLATES.map((template) => template.category))).toEqual(
      new Set(BOT_CATEGORIES.map((category) => category.id))
    );

    for (const template of BOT_TEMPLATES) {
      expect(template.author).toBe("Busy");
      expect(template.description.length).toBeLessThanOrEqual(140);
      expect(template.instructions.length).toBeLessThanOrEqual(8000);
      expect(template.instructions).toMatch(EXPLICIT_APPROVAL_PATTERN);
      expect(template.starterPrompts.length).toBeGreaterThan(0);
      expect(template.suggestedTools.length).toBeGreaterThan(0);
      expect(
        template.suggestedTools.every((tool) => typeof tool === "string")
      ).toBe(true);
      const color = pixFor(template.id, template.avatar);
      expect(PIX_KEYS).toContain(color);
      expect(avatarFor(color, variantFor(template.avatar))).toBe(
        template.avatar
      );
    }
  });

  it("keeps a small featured set and supports stable lookup", () => {
    expect(FEATURED_BOT_TEMPLATES.length).toBe(4);
    expect(FEATURED_BOT_TEMPLATES.every((template) => template.featured)).toBe(
      true
    );
    expect(botTemplate("release-captain")?.name).toBe("Release Captain");
    expect(botTemplate("missing-template")).toBeUndefined();
  });

  it("searches card content without case or accent sensitivity", () => {
    expect(
      searchBotTemplates("RÉSUMÉ").map((template) => template.id)
    ).toContain("meeting-prep");
    expect(
      searchBotTemplates("RELEASE").map((template) => template.id)
    ).toContain("release-captain");
    const sales = searchBotTemplates("customer", "sales");
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.every((template) => template.category === "sales")).toBe(true);
  });

  it("filters categories and treats an empty query as browse", () => {
    const engineering = searchBotTemplates("", "engineering");
    expect(engineering.length).toBeGreaterThan(0);
    expect(
      engineering.every((template) => template.category === "engineering")
    ).toBe(true);
    expect(searchBotTemplates("", "all")).toHaveLength(BOT_TEMPLATES.length);
    expect(searchBotTemplates("")).toHaveLength(BOT_TEMPLATES.length);
  });
});
