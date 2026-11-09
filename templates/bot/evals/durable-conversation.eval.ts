import { defineEval } from "eve/evals";
import { providerAuthAvailable } from "./availability";

/**
 * Real-model regression signal for the Busy experience: delegate the long
 * operation, keep the parent conversation available, and return a useful
 * deliverable when the child finishes. `calledAgent` stays soft because model
 * routing is probabilistic; the protocol and file-tool tests are hard gates.
 *
 * Run explicitly with `eve eval durable-conversation --strict` after the
 * target has Gateway credentials. It is intentionally not part of the local
 * no-credential unit-test command.
 */
export default defineEval({
  description:
    "The bot delegates long file work while preserving the parent conversation.",
  tags: ["real-model", "delegation", "durability"],
  async test(t) {
    if (!providerAuthAvailable()) {
      t.skip("requires a linked Vercel target or AI Gateway/OIDC credentials");
      return;
    }
    const session = await t.session();
    const firstLive = await session.start(
      "Start a long-running file task: write a one-page plain-text note about why durable workflows help agents, save it under /data/work/durable-eval/note.txt, and delegate the work to the built-in agent. Tell me what you started without claiming the file is finished before you have checked it. Keep the child task running while you wait for further instructions."
    );
    await firstLive.waitForEvent("task.started", { data: { kind: "agent" } });

    // Start the correction while the first turn is still in flight. This is
    // the behavior the chat must support; do not await firstLive.result() first.
    const secondLive = await session.start(
      "Correction for the same running task: keep the note to one page, add a Limitations paragraph, and continue the existing child by its taskId. Do not start a duplicate child."
    );
    const first = await firstLive.result();
    const second = await secondLive.result();
    first.expectOk();
    second.expectOk();
    first.calledAgent("agent", { count: (count) => count >= 1 }).soft();
    second.calledAgent("agent", { count: (count) => count >= 1 }).soft();
    t.eventsSatisfy(
      "the correction continues the same child task",
      (events) => {
        const taskIds = events
          .filter(
            (event) =>
              event.type === "task.started" &&
              (event.data as { kind?: string }).kind === "agent"
          )
          .map((event) => (event.data as { taskId?: string }).taskId)
          .filter((taskId): taskId is string => taskId !== undefined);
        const continued = events
          .filter(
            (event) =>
              event.type === "call.started" &&
              (event.data as { taskId?: string }).taskId !== undefined
          )
          .map((event) => (event.data as { taskId: string }).taskId);
        return (
          taskIds.length >= 1 &&
          continued.length >= 2 &&
          new Set(continued).size === 1
        );
      }
    ).gate();
    second.calledTool("send_file", { count: 1, status: "completed" });
    t.judge(
      "The assistant clearly distinguishes work that has started from a finished deliverable, keeps the user informed briefly, and does not invent a file that it has not produced.",
      { on: first.session.transcript }
    ).atLeast(0.72);

    t.judge(
      "The assistant incorporates the correction into the ongoing work and does not claim success without evidence.",
      { on: second.session.transcript }
    ).atLeast(0.72);
  },
});
