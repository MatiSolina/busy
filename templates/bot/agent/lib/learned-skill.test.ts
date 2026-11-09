import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { saveLearnedSkill } from "./learned-skill";
import { proposalPrompt } from "./learned-skill-input";

const UPDATE_PROMPT = /^Update the skill/u;
const UNEXPECTED = /unexpected/u;

const skill = {
  description: "Build the monthly report.",
  instructions: "1. Export.\n2. Group.\n3. Send it with send_file to the user.",
  name: "monthly-report",
};
const id = "11111111-1111-4111-8111-111111111111";
const loadName = `s_${createHash("sha256").update(`${id}\0${skill.name}`).digest("hex").slice(0, 16)}_${skill.name}`;

describe("learned skill client", () => {
  it("phrases the proposal the user answers", () => {
    expect(proposalPrompt(skill, false)).toBe(
      'Save the skill "monthly-report"? Build the monthly report. (3 lines of instructions; you can read and edit it in Skills.)'
    );
    expect(proposalPrompt(skill, true)).toMatch(UPDATE_PROMPT);
  });

  it("posts the skill and checks the load name the hub returns", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { capability: { id, name: skill.name }, created: true, loadName },
        { status: 201 }
      )
    );
    await expect(
      saveLearnedSkill({ ...skill, edit: false }, undefined, fetcher)
    ).resolves.toMatchObject({ created: true, loadName });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/bot/skills/learned",
      expect.objectContaining({
        body: JSON.stringify({ ...skill, edit: false }),
        method: "POST",
      })
    );
  });

  it("surfaces the hub's reason and refuses a mismatched answer", async () => {
    await expect(
      saveLearnedSkill({ ...skill, edit: false }, undefined, async () =>
        Response.json({ error: "Pick another name." }, { status: 409 })
      )
    ).rejects.toThrow("Pick another name.");
    await expect(
      saveLearnedSkill({ ...skill, edit: false }, undefined, async () =>
        Response.json({
          capability: { id, name: skill.name },
          created: true,
          loadName: "s_x_y",
        })
      )
    ).rejects.toThrow(UNEXPECTED);
  });
});
