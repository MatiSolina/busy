import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import { holdComputer } from "../lib/computer";
import { deferredAtCore } from "../lib/lazy-tools";

// A login the bot can't (and mustn't) get past alone. The turn pauses on a card in the user's chat (hub
// lib/chat/items.ts, kind "login"): the user takes control of the live screen, logs in and taps Done.
// A paused turn never settles, so hooks/suspend.ts leaves the computer on and Chrome is still there;
// the hub holds it past the sandbox timeout (bounded) while the user logs in.
export default defineWorkflowTool({
  deferred: deferredAtCore("request_login"),
  description:
    "Ask the user to log in on your screen when a task stops at a login (username and password, a code by SMS or email, a captcha). Leave the login page open in Chrome before you call it. Waits until the user is done.",
  async execute({ task, site }, ctx) {
    "use workflow";
    // A consultation answers another bot: nobody is there to log in.
    if (isConsultation(ctx.session.auth)) {
      return {
        loggedIn: false,
        reason: "You can't ask for a login in a consultation.",
      };
    }
    // The computer's own timeout would end a login that takes longer: the hub holds it (bounded)
    // and extends that timeout until the user answers or the question is withdrawn.
    await holdStep({ hold: true, sessionId: ctx.session.id });
    let answer: Awaited<ReturnType<typeof ctx.ask>>;
    try {
      answer = await ctx.ask({
        display: "confirmation",
        options: [{ id: "done", label: "Done", style: "primary" }],
        prompt: `To ${task}, I need you to log in to ${site}.`,
      });
    } finally {
      await holdStep({ hold: false, sessionId: ctx.session.id });
    }
    if (answer.status === "answered") {
      return {
        loggedIn: true,
        next: "Check the screen to confirm the user got in, and go on from there.",
      };
    }
    // Withdrawn: the user wrote something else instead (eve steers the turn with it), or the turn stopped.
    return {
      loggedIn: false,
      reason:
        answer.status === "cancelled"
          ? "The user wrote something else: read that message."
          : "Nobody is there to log in right now.",
    };
  },
  inputSchema: z.object({
    site: z
      .string()
      .min(1)
      .max(100)
      .describe(
        'Where the user has to log in: "the tax office", "Chase online banking"'
      ),
    task: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'What you were about to do, as a verb phrase: "download October\'s invoices"'
      ),
  }),
});

/** The hub's login hold (lib/computer.ts). Never throws: without it the timeout still bounds the computer. */
async function holdStep(input: {
  hold: boolean;
  sessionId: string;
}): Promise<boolean> {
  "use step";
  return await holdComputer(input.sessionId, input.hold);
}
