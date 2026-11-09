import type { Billing } from "../bots/models";
import { type ChatItem, type ClientRow, toChatView } from "./items";

const NO_DELTAS: ReadonlyMap<string, string> = new Map();

export interface ArchivedSession {
  rows: readonly ClientRow[];
  sessionId: string;
}

/**
 * Projects replaced sessions once per immutable input snapshot.
 *
 * Callers keep this result behind a dependency-aware memo (the chat pane does that) so a live
 * delta only projects the current session. Keep the session-id prefix and terminal-state mapping
 * here: these are presentation rules, not a cache shortcut, and must stay identical to the old
 * combined projection.
 */
export function projectArchivedItems(
  sessions: readonly ArchivedSession[],
  consults: ReadonlyMap<string, { id: string; peerName: string }>,
  peerNames: string,
  billing: Billing
): ChatItem[] {
  const names = peerNames.split("\u0000");
  const slot = (n: number) => names[n - 1];
  return sessions.flatMap((session) =>
    toChatView(session.rows, NO_DELTAS, consults, slot, billing).items.map(
      (item): ChatItem => {
        const id = `${session.sessionId}:${item.id}`;
        if (
          item.kind === "activity" &&
          item.taskId &&
          item.state === "running"
        ) {
          return { ...item, detail: "Session replaced", id, state: "stopped" };
        }
        if (item.kind === "activity" && item.state === "running") {
          return { ...item, id, state: "error" };
        }
        // A lost session's question can't be answered anymore.
        if (item.kind === "login" && item.state === "open") {
          return { ...item, id, state: "closed" };
        }
        if (item.kind === "interaction" && item.state === "open") {
          return {
            ...item,
            id,
            outcome: "Session replaced",
            state: "withdrawn",
          };
        }
        return { ...item, id };
      }
    )
  );
}
