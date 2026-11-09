import { z } from "zod";
import { verifiedMcpAppCall } from "../mcp/apps-client";
import { getFireside } from "./store";

/** A UI scope can select only a stored fireside reply, never an arbitrary session. */
export async function firesideMcpAppCall(
  slug: string,
  callId: string,
  source: string
) {
  const parsed = z.tuple([z.uuid(), z.uuid()]).safeParse(source.split("/"));
  if (!parsed.success) {
    return null;
  }
  const [id, messageId] = parsed.data;
  const fire = await getFireside(id);
  if (!fire) {
    return null;
  }
  const { active } = fire.state;
  const message = fire.state.messages.find(
    (value) => value.id === messageId && value.speaker !== "user"
  );
  const role =
    active?.messageId === messageId ? active.participant : message?.speaker;
  if (!role || role === "user") {
    return null;
  }
  const participant = fire.state.participants[role];
  const runtime =
    active?.messageId === messageId
      ? { calls: active.rows, sessionId: participant.sessionId }
      : message?.runtime;
  if (participant.slug !== slug || !runtime?.sessionId) {
    return null;
  }
  const requested = runtime.calls.find(
    (row) => row.type === "call.requested" && row.data.data.callId === callId
  );
  const settled = runtime.calls.find(
    (row) => row.type === "call.settled" && row.data.data.callId === callId
  );
  if (!(requested && settled)) {
    return null;
  }
  return verifiedMcpAppCall(
    slug,
    participant.botId,
    runtime.sessionId,
    callId,
    requested,
    settled
  );
}
