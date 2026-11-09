import { describe, expect, it } from "vitest";
import {
  buildRecoveryPacket,
  MAX_RECOVERY_PACKET_BYTES,
  MAX_RECOVERY_TOOLS,
  type RecoveryConversationSource,
  type RecoveryEvent,
  type RecoveryPacket,
} from "./recovery";

const AT = new Date("2026-11-09T10:00:00.000Z");

function longIdentifier(prefix: string): string {
  return `${prefix}-${"界".repeat(190)}`;
}

function byteLength(packet: RecoveryPacket): number {
  return Buffer.byteLength(JSON.stringify(packet), "utf8");
}

function largeRecoveryEvents(): RecoveryEvent[] {
  const rows: RecoveryEvent[] = [];
  for (let index = 0; index < MAX_RECOVERY_TOOLS; index += 1) {
    const callId = longIdentifier(`call-${index}`);
    const sessionId = longIdentifier(`session-${index}`);
    rows.push(
      {
        at: AT,
        data: { callId, capability: { name: "read_file" } },
        index: 0,
        line: index * 3,
        sessionId,
        type: "call.requested",
      },
      {
        at: AT,
        data: { callId },
        index: 1,
        line: index * 3 + 1,
        sessionId,
        type: "call.started",
      },
      {
        at: AT,
        data: { callId, outcome: "completed" },
        index: 2,
        line: index * 3 + 2,
        sessionId,
        type: "call.settled",
      }
    );
  }
  return rows;
}

function largeConversation(): RecoveryConversationSource[] {
  return Array.from({ length: 64 }, (_, index) => ({
    at: AT,
    id: longIdentifier(`message-${index}`),
    role: "user" as const,
    sessionId: "old",
    text: "Continue the work.",
  }));
}

describe("recovery packet byte budget", () => {
  it("trims long Unicode action and history ids to the UTF-8 bound", () => {
    const packet = buildRecoveryPacket(
      largeRecoveryEvents(),
      largeConversation(),
      "old",
      AT
    );

    expect(byteLength(packet)).toBeLessThanOrEqual(MAX_RECOVERY_PACKET_BYTES);
    expect(packet.actions.started.length).toBeLessThan(MAX_RECOVERY_TOOLS);
    expect(packet.actions.completed.length).toBeLessThan(MAX_RECOVERY_TOOLS);
    expect(packet.history.eventIds.length).toBeLessThan(256);
    expect(packet.history.messageIds.length).toBeLessThan(64);
  });

  it("fails closed when fixed metadata alone exceeds the byte bound", () => {
    expect(() =>
      buildRecoveryPacket([], [], "界".repeat(MAX_RECOVERY_PACKET_BYTES), AT)
    ).toThrow("Recovery packet exceeds its byte bound.");
  });

  it("keeps sensitive conversation values redacted", () => {
    const secret = `sk-${"a".repeat(64)}`;
    const packet = buildRecoveryPacket(
      [
        {
          at: AT,
          data: {
            callId: "read-secret",
            capability: { name: "read_file" },
            input: { token: `token=${secret}` },
          },
          index: 0,
          line: 1,
          sessionId: "old",
          type: "call.requested",
        },
      ],
      [
        {
          at: AT,
          id: "message-1",
          role: "user",
          sessionId: "old",
          text: `authorization=${secret}`,
        },
      ],
      "old",
      AT
    );

    expect(JSON.stringify(packet)).not.toContain(secret);
  });
});
