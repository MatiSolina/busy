import { describe, expect, it } from "vitest";
import { parseQuickReplies } from "./quick-replies";

describe("quick replies", () => {
  it("trims, collapses spaces and drops duplicates", () => {
    expect(
      parseQuickReplies({
        replies: [" Send  it ", "send it", "Make it shorter"],
      })
    ).toEqual({ ok: true, replies: ["Send it", "Make it shorter"] });
  });

  it("refuses lists out of bounds", () => {
    expect(parseQuickReplies({ replies: [] })).toMatchObject({ ok: false });
    expect(parseQuickReplies({ replies: ["a", "b", "c", "d"] })).toMatchObject({
      ok: false,
    });
    expect(parseQuickReplies({ replies: ["x".repeat(41)] })).toMatchObject({
      ok: false,
    });
    expect(parseQuickReplies({ replies: [1] })).toMatchObject({ ok: false });
    expect(parseQuickReplies(null)).toMatchObject({ ok: false });
  });
});
