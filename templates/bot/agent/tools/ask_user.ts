import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";

// One decision only the user can make, as a card with buttons in their chat (hub lib/chat/items.ts,
// kind "interaction"). Pausing the turn keeps the work where it is until they answer.
export default defineWorkflowTool({
  description:
    "Ask the user one question that only they can answer, as a card with 2 to 4 buttons, and wait for the answer. Use it only when a wrong guess has real consequences or the choice materially changes the result; otherwise decide and go on. Every option must be real and checked, worded as the user would answer. Style a destructive choice as danger and the recommended one as primary. Put any explanation in your reply text before calling it. Not for confirming a connected-app action: that tool shows its own approval card.",
  async execute({ question, options, allowFreeText }, ctx) {
    "use workflow";
    // A consultation answers another bot: there is no user to ask.
    if (isConsultation(ctx.session.auth)) {
      return {
        reason: "There is no user to ask in a consultation.",
        status: "unavailable",
      };
    }
    const answer = await ctx.ask({
      allowFreeform: allowFreeText,
      display: "select",
      options: options.map((option, i) => ({
        id: String(i),
        label: option.label,
        ...(option.style ? { style: option.style } : {}),
      })),
      prompt: question,
    });
    if (answer.status !== "answered") {
      return answer.status === "cancelled"
        ? {
            reason:
              "The user wrote something else instead: read that message. Don't ask the same question again.",
            status: "interrupted",
          }
        : { reason: "Nobody is there to answer now.", status: "unavailable" };
    }
    return { answer: answerText(answer, options), status: "answered" };
  },
  inputSchema: z.object({
    allowFreeText: z
      .boolean()
      .default(false)
      .describe("Let the user type an answer instead of tapping a button."),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          style: z.enum(["primary", "danger"]).optional(),
        })
      )
      .min(2)
      .max(4),
    question: z
      .string()
      .min(1)
      .max(300)
      .describe("One natural question, with the context needed to answer it."),
  }),
});

/** The chosen option's label, or the text the user typed. */
function answerText(
  answer: { optionId?: string; text?: string },
  options: readonly { label: string }[]
): string {
  const picked =
    answer.optionId === undefined
      ? undefined
      : options[Number(answer.optionId)];
  return picked?.label ?? answer.text ?? "";
}
