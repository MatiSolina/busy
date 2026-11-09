import { describe, expect, it, vi } from "vitest";
import {
  projectFxEvent,
  settleTurnBeforePending,
  terminalAttentionMessage,
} from "./runtime";

vi.mock("./store", () => ({}));
vi.mock("./agent-tools", () => ({
  codeInstructions: "",
  codingTools: vi.fn(),
  safeCodeOutput: (text: string) =>
    text.replace(/Bearer [^ ]+/gu, "[redacted]"),
}));
vi.mock("./notify", () => ({}));

describe("fx event projection", () => {
  it("keeps reasoning out of the user-facing activity stream", () => {
    expect(
      projectFxEvent({
        delta: "private reasoning",
        messageId: "message",
        type: "reasoning_delta",
      })
    ).toBeNull();
  });
  it("shows actual tool errors and excludes provider credentials", () => {
    expect(
      projectFxEvent({
        content: "Error Bearer secret",
        id: "call",
        isError: true,
        messageId: "message",
        name: "shell",
        type: "tool_end",
      })
    ).toEqual({
      data: {
        callId: "call",
        isError: true,
        name: "shell",
        output: "Error [redacted]",
      },
      type: "tool.end",
    });
  });
  it("keeps tool inputs and assistant narration visible", () => {
    expect(
      projectFxEvent({
        id: "call",
        input: { command: "pnpm test" },
        messageId: "message",
        name: "shell",
        type: "tool_start",
      })
    ).toEqual({
      data: {
        callId: "call",
        command: '{"command":"pnpm test"}',
        name: "shell",
      },
      type: "tool.start",
    });
    expect(
      projectFxEvent({
        delta: "I found the failing test.",
        messageId: "message",
        type: "text_delta",
      })
    ).toEqual({
      data: { message: "I found the failing test." },
      type: "agent.message",
    });
  });
  it("exposes recovery as continuing the same work rather than a new task", () => {
    expect(
      projectFxEvent({
        messageId: "same-command",
        sessionId: "same-session",
        type: "turn_resume",
      })
    ).toMatchObject({
      data: { message: "Resuming the saved task" },
      type: "agent.working",
    });
  });

  it("marks a prestart error terminal when no newer steer is pending", () => {
    const line = {
      messageId: "steer-1",
      stopReason: "error",
      type: "turn_end",
    } as const;
    expect(
      terminalAttentionMessage(
        line,
        {
          appliedInstructionVersion: 0,
          instructionVersion: 1,
          status: "running",
        },
        false
      )
    ).toBe(
      "The coding agent could not finish. Check its AI connection and task activity."
    );
    expect(
      terminalAttentionMessage(
        line,
        {
          appliedInstructionVersion: 0,
          instructionVersion: 1,
          status: "running",
        },
        true
      )
    ).toBeNull();
  });

  it.each([false, true])(
    "settles the ending command before checking pending work (newer steer: %s)",
    async (newerSteer) => {
      const commands = [
        { kind: "steer", status: "accepted" },
        ...(newerSteer ? [{ kind: "steer", status: "queued" }] : []),
      ];
      const hasPending = await settleTurnBeforePending(
        () =>
          Promise.resolve().then(() => {
            commands[0].status = "settled";
          }),
        async () =>
          commands.some(
            (command) =>
              ["queued", "leased", "accepted"].includes(command.status) &&
              command.kind !== "cancel"
          )
      );
      expect(hasPending).toBe(newerSteer);
      expect(commands[0].status).toBe("settled");
    }
  );
});
