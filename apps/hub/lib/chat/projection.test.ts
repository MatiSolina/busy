import { describe, expect, it } from "vitest";
import { type ClientRow, toChatView } from "./items";
import { type ArchivedSession, projectArchivedItems } from "./projection";

const row = (
  line: number,
  type: string,
  data: Record<string, unknown>
): ClientRow => ({
  data: { data, type },
  index: 0,
  line,
  type,
});

describe("archived chat projection", () => {
  it("keeps session ids and closes interactions that cannot be answered", () => {
    const rows: ClientRow[] = [
      row(0, "delivery.consumed", {
        deliveryId: "delivery-1",
        parts: [{ kind: "text", text: "Question" }],
      }),
      row(1, "turn.started", { turnId: "turn-1" }),
      row(2, "interaction.opened", {
        interactionId: "interaction-1",
        request: {
          kind: "question",
          options: [{ id: "yes", label: "Yes" }],
          prompt: "Choose",
        },
      }),
    ];
    const sessions: ArchivedSession[] = [{ rows, sessionId: "old-session" }];
    const items = projectArchivedItems(sessions, new Map(), "", "gateway");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "old-session:delivery-1",
      kind: "user",
    });
    expect(items[1]).toMatchObject({
      id: "old-session:interaction-1",
      outcome: "Session replaced",
      state: "withdrawn",
    });
  });

  it("matches the previous combined projection for all archived items", () => {
    const rows: ClientRow[] = [
      row(0, "delivery.consumed", {
        deliveryId: "delivery-1",
        parts: [{ kind: "text", text: "Question" }],
      }),
      row(1, "turn.started", { turnId: "turn-1" }),
      row(2, "content.completed", {
        kind: "text",
        partId: "part-1",
        phase: "reply",
        value: "Answer",
      }),
      row(3, "turn.settled", { outcome: "completed", turnId: "turn-1" }),
    ];
    const sessions: ArchivedSession[] = [
      { rows, sessionId: "old-session" },
      {
        rows: rows.map((item) => ({ ...item, line: item.line + 10 })),
        sessionId: "older-session",
      },
    ];
    const old = sessions.flatMap((session) =>
      toChatView(
        session.rows,
        new Map(),
        new Map(),
        () => undefined,
        "gateway"
      ).items.map((item) => ({
        ...item,
        id: `${session.sessionId}:${item.id}`,
      }))
    );
    expect(projectArchivedItems(sessions, new Map(), "", "gateway")).toEqual(
      old
    );
  });
});
