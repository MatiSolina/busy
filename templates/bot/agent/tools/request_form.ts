import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import { holdComputer } from "../lib/computer";
import { deferredAtCore } from "../lib/lazy-tools";

// Fields only the user should type (a login, a card, an address). The turn pauses on a form card in
// the user's chat (hub lib/chat/items.ts, a "login" item with `form`). On Submit the hub fills the
// page inside this computer itself and answers with a result that carries no values: the values never
// reach this tool, the model, the event log or the hub's database. "I'll type it myself" is the login
// flow: the user takes control and taps Done.
export const FIELD_KINDS = [
  "text",
  "email",
  "password",
  "otp",
  "tel",
  "card-number",
  "card-expiry",
  "card-cvc",
  "address",
] as const;

const field = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/u)
    .describe('"username", "card_cvc"'),
  kind: z.enum(FIELD_KINDS),
  label: z.string().min(1).max(60),
  target: z.string().min(1).max(300).describe('"@e12" or a CSS selector'),
});

export default defineWorkflowTool({
  deferred: deferredAtCore("request_form"),
  description:
    "Have the user fill fields only they should type (login, one-time code, card, address, phone) on the page open in Chrome. They type into a secure form in the chat and the hub fills the page; you never see the values. Right before calling, take a browser__snapshot and pass each field's ref (@e12) or a CSS selector as `target`. Waits until done; then check the page and go on.",
  async execute({ task, site, fields }, ctx) {
    "use workflow";
    const ids = fields.map((f) => f.id);
    if (isConsultation(ctx.session.auth)) {
      return {
        failed: ids,
        filled: false,
        next: "You can't ask the user for a form in a consultation.",
      };
    }
    await holdStep({ hold: true, sessionId: ctx.session.id });
    let answer: Awaited<ReturnType<typeof ctx.ask>>;
    try {
      answer = await ctx.ask({
        display: "confirmation",
        options: [
          { id: "filled", label: "Filled" },
          { id: "failed", label: "Couldn't fill" },
          { id: "done", label: "Done", style: "primary" },
        ],
        prompt: `To ${task}, I need you to fill this in on ${site}.`,
      });
    } finally {
      await holdStep({ hold: false, sessionId: ctx.session.id });
    }
    return formResult(answer, ids);
  },
  inputSchema: z.object({
    fields: z
      .array(field)
      .min(1)
      .max(8)
      .refine(
        (list) => new Set(list.map((f) => f.id)).size === list.length,
        "Field ids must be unique"
      ),
    site: z.string().min(1).max(100).describe('"Chase online banking"'),
    task: z
      .string()
      .min(1)
      .max(200)
      .describe('A verb phrase: "pay the October invoice"'),
  }),
});

type Answer =
  | { status: "answered"; optionId?: string; text?: string }
  | { status: "cancelled" }
  | { status: "unavailable" };

const RETRY =
  "Call request_login so the user takes control and types it on the screen directly.";

/** What the model gets back: field ids and outcomes, never a value. */
export function formResult(answer: Answer, ids: string[]) {
  if (answer.status !== "answered") {
    return {
      failed: ids,
      filled: false,
      next:
        answer.status === "cancelled"
          ? "The user wrote something else: read that message."
          : "Nobody is there to fill it in right now.",
    };
  }
  if (answer.optionId === "filled") {
    return { fields: ids, filled: true };
  }
  if (answer.optionId === "done") {
    // The user took control and typed it on the screen.
    return {
      fields: ids,
      filled: true,
      next: "The user typed it on the screen: check it and go on.",
    };
  }
  // "failed": the hub lists the field ids it couldn't fill in the answer's text.
  const named = (answer.text ?? "").split(",").filter((id) => ids.includes(id));
  return { failed: named.length ? named : ids, filled: false, next: RETRY };
}

async function holdStep(input: {
  hold: boolean;
  sessionId: string;
}): Promise<boolean> {
  "use step";
  return await holdComputer(input.sessionId, input.hold);
}
