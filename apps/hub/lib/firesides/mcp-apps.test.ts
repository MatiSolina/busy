import { beforeEach, describe, expect, it, vi } from "vitest";
import { row } from "../chat/chat.test-helpers";
import { firesideMcpAppCall } from "./mcp-apps";
import { initialState } from "./test-helpers";

const mocks = vi.hoisted(() => ({ getFireside: vi.fn(), verify: vi.fn() }));
vi.mock("./store", () => ({ getFireside: mocks.getFireside }));
vi.mock("../mcp/apps-client", () => ({ verifiedMcpAppCall: mocks.verify }));
const fireId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  vi.clearAllMocks();
});
describe("fireside MCP App provenance", () => {
  it("replays an archived guest app from that participant's isolated session", async () => {
    const state = initialState();
    state.status = "closed";
    state.participants.guest.sessionId = null;
    state.messages.push({
      at: new Date().toISOString(),
      id: messageId,
      runtime: {
        calls: [
          row(1, "call.requested", { callId: "call" }),
          row(2, "call.settled", { callId: "call" }),
        ],
        sessionId: "retired-fire-guest",
      },
      speaker: "guest",
      text: "Result",
    });
    mocks.getFireside.mockResolvedValue({ state });
    mocks.verify.mockResolvedValue({ snapshotVerified: true });
    expect(
      await firesideMcpAppCall("guest", "call", `${fireId}/${messageId}`)
    ).toEqual({ snapshotVerified: true });
    expect(mocks.verify.mock.calls[0]?.slice(0, 4)).toEqual([
      "guest",
      state.participants.guest.botId,
      "retired-fire-guest",
      "call",
    ]);
    expect(
      await firesideMcpAppCall("primary", "call", `${fireId}/${messageId}`)
    ).toBeNull();
    expect(
      await firesideMcpAppCall(
        "guest",
        "guessed-call",
        `${fireId}/${messageId}`
      )
    ).toBeNull();
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });
  it("rejects arbitrary session ids and unrelated message scopes", async () => {
    mocks.getFireside.mockResolvedValue({ state: initialState() });
    expect(
      await firesideMcpAppCall("guest", "call", "some-session")
    ).toBeNull();
    expect(
      await firesideMcpAppCall("guest", "call", `${fireId}/${messageId}`)
    ).toBeNull();
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
