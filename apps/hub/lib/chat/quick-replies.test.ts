import { describe, expect, it } from "vitest";
import {
  callSettled,
  modelDone,
  reply,
  requested,
  said,
  seq,
  settled,
  started,
  view,
} from "./chat.test-helpers";

const offer = (replies: unknown) =>
  requested("call-replies", "suggest_replies", { replies });

describe("quick replies in the chat view", () => {
  it("offers the replies of a finished turn and hides the tool call", () => {
    const v = view(
      seq(
        said("d1", "Draft the email"),
        started("t1"),
        reply("p1", "Here it is."),
        offer(["Send it", "Make it shorter"]),
        callSettled("call-replies", "completed"),
        modelDone(),
        settled("t1")
      )
    );
    expect(v.replies).toEqual(["Send it", "Make it shorter"]);
    expect(v.items.some((i) => i.kind === "activity")).toBe(false);
  });

  it("offers nothing while the turn runs, after Stop, or once the user writes", () => {
    expect(
      view(seq(said("d1", "Hi"), started("t1"), offer(["Yes"]))).replies
    ).toEqual([]);
    expect(
      view(
        seq(
          said("d1", "Hi"),
          started("t1"),
          reply("p1", "…"),
          offer(["Yes"]),
          settled("t1", "cancelled")
        )
      ).replies
    ).toEqual([]);
    expect(
      view(
        seq(
          said("d1", "Hi"),
          started("t1"),
          reply("p1", "Ok"),
          offer(["Yes"]),
          settled("t1"),
          said("d2", "Something else")
        )
      ).replies
    ).toEqual([]);
  });

  it("offers nothing when Stop or a failure cuts a tool that was still running", () => {
    for (const outcome of ["cancelled", "failed"]) {
      expect(
        view(
          seq(
            said("d1", "Draft the email"),
            started("t1"),
            reply("p1", "Here it is."),
            offer(["Send it"]),
            requested("call-bash", "bash", { command: "sleep 60" }),
            settled("t1", outcome)
          )
        ).replies
      ).toEqual([]);
    }
  });

  it("keeps the last valid list and ignores an invalid one", () => {
    const v = view(
      seq(
        said("d1", "Hi"),
        started("t1"),
        offer(["a", "b", "c", "d"]),
        offer(["Yes", "No"]),
        reply("p1", "Ok?"),
        settled("t1")
      )
    );
    expect(v.replies).toEqual(["Yes", "No"]);
    expect(
      view(
        seq(
          said("d1", "Hi"),
          started("t1"),
          reply("p1", "Ok"),
          offer(["x".repeat(60)]),
          settled("t1")
        )
      ).replies
    ).toEqual([]);
  });
});
