import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { isConsultation, isRoutineExecution } from "../lib/caller";
import { deferredAtCore } from "../lib/lazy-tools";
import { saveLearnedSkill } from "../lib/learned-skill";
import { learnedSkillInput, proposalPrompt } from "../lib/learned-skill-input";

// eve requires a workflow tool as the default export itself, so the "only the user's own chat" rule is
// checked when it runs: nobody is there to answer in a consultation, a routine run or a child task.
export default defineWorkflowTool({
  deferred: deferredAtCore("propose_skill"),
  description:
    "Offer to save a workflow you just finished as a reusable skill, so next time you follow the same steps. Use it after a multi-step task the user is likely to repeat (a report, a cleanup, a recurring email), or when the user corrected how you did something you'll do again; to change a skill you saved before, pass the same name and edit=true. The user sees a card and taps Save or Not now; nothing is saved without that.",
  async execute({ edit, ...skill }, ctx) {
    "use workflow";
    if (
      isConsultation(ctx.session.auth) ||
      isRoutineExecution(ctx.session.auth) ||
      ctx.session.parent
    ) {
      return {
        reason: "Only the user's own chat can save skills.",
        saved: false,
      };
    }
    const answer = await ctx.ask({
      display: "confirmation",
      options: [
        {
          id: "save",
          label: edit ? "Update skill" : "Save skill",
          style: "primary",
        },
        { id: "skip", label: "Not now" },
      ],
      prompt: proposalPrompt(skill, edit),
    });
    if (answer.status !== "answered") {
      return {
        reason:
          answer.status === "cancelled"
            ? "The user wrote something else: read that message."
            : "No answer.",
        saved: false,
      };
    }
    if (answer.optionId !== "save") {
      return {
        reason:
          "The user chose not to save it. Don't offer this skill again in this conversation.",
        saved: false,
      };
    }
    const saved = await saveStep({ ...skill, edit });
    return {
      created: saved.created,
      loadName: saved.loadName,
      next: "Tell the user in one line that the skill is saved. It loads on the next model call with eve__skill and loadName.",
      saved: true,
    };
  },
  inputSchema: learnedSkillInput.extend({
    edit: z
      .boolean()
      .default(false)
      .describe(
        "true when rewriting a skill you saved earlier under this name"
      ),
  }),
  label: { start: ({ name }) => `Propose skill ${name}` },
});

async function saveStep(
  skill: z.infer<typeof learnedSkillInput> & { edit: boolean }
) {
  "use step";
  return await saveLearnedSkill(skill);
}
