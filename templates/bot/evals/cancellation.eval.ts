import { defineEval } from "eve/evals";
import { providerAuthAvailable } from "./availability";

/**
 * Optional provider-backed check for the distinction between steering and
 * cancellation: stopping the active turn must terminate the running child
 * task, while an ordinary follow-up is allowed to steer it.
 */
export default defineEval({
  description: "Stopping a running turn cancels its durable child task.",
  tags: ["real-model", "delegation", "cancellation"],
  async test(t) {
    if (!providerAuthAvailable()) {
      t.skip("requires a linked Vercel target or AI Gateway/OIDC credentials");
      return;
    }
    const session = await t.session();
    const live = await session.start(
      "Delegate a long-running task to the built-in agent. Keep it working for a while and do not finish the parent turn until the child is active."
    );
    await live.waitForEvent("task.started", { data: { kind: "agent" } });
    await live.cancel();
    const result = await live.result();
    result.event("turn.settled", { data: { outcome: "cancelled" } });
    t.eventsSatisfy("the child task ends after cancellation", (events) =>
      events.some(
        (event) =>
          event.type === "task.ended" &&
          (event.data as { outcome?: string }).outcome === "cancelled"
      )
    ).gate();
  },
});
