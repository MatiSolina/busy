import { describe, expect, it } from "vitest";
import {
  FAST_INDEX_BASE,
  fastAckEnabled,
  fastAckRows,
  fastClosingRows,
  fastOpeningRows,
  fastPathEnabled,
  fastSystemPrompt,
  routeFast,
  withFastAck,
  withFastExchanges,
} from "./fast-path";
import { toChatView } from "./items";
import { waitStage } from "./status";

describe("fast path flag", () => {
  it("is off unless the slug or * is listed", () => {
    expect(fastPathEnabled("ana", undefined)).toBe(false);
    expect(fastPathEnabled("ana", "")).toBe(false);
    expect(fastPathEnabled("ana", "bob, qa")).toBe(false);
    expect(fastPathEnabled("ana", "bob, ana")).toBe(true);
    expect(fastPathEnabled("ana", "*")).toBe(true);
  });
});

describe("fast path router", () => {
  const route = (text: string, fileIds: string[] = []) =>
    routeFast({ fileIds, text });

  it.each([
    "hola, ¿cómo estás?",
    "Thanks, that helps!",
    "¿Qué opinás de esta idea para el nombre?",
    "What's the difference between a list and a tuple?",
  ])("takes small talk and simple questions: %s", (text) => {
    expect(route(text)).toEqual({ fast: true });
  });

  it.each([
    ["abrí el navegador", "action"],
    ["buscá vuelos a Madrid", "action"],
    ["Recordá que prefiero café", "action"],
    ["programá un recordatorio a las 9", "action"],
    ["mandale un mail a Juan", "action"],
    ["creá una planilla", "action"],
    ["Please search for the latest news", "action"],
    ["open the file I sent", "action"],
    ["send it to Ana", "action"],
    ["schedule a meeting tomorrow", "action"],
    ["mirá https://example.com", "url"],
    ["qué hay en midday.ai", "url"],
  ])("sends actions and links the normal way: %s", (text, reason) => {
    expect(route(text)).toEqual({ fast: false, reason });
  });

  it("never takes files, empty or long messages", () => {
    expect(route("hola", ["f"])).toEqual({ fast: false, reason: "files" });
    expect(route("   ")).toEqual({ fast: false, reason: "empty" });
    expect(route("a".repeat(301))).toEqual({ fast: false, reason: "long" });
  });
});

describe("fast path rows", () => {
  const slot = { index: FAST_INDEX_BASE, line: 41 };
  const id = "22222222-2222-4222-8222-222222222222";
  const rows = [
    ...fastOpeningRows(slot, id, "hola"),
    ...fastClosingRows(slot, id, "¡Hola!"),
  ];

  it("stay on eve's last line, above any index eve uses", () => {
    expect(rows.map((r) => [r.line, r.index - FAST_INDEX_BASE])).toEqual([
      [41, 0],
      [41, 1],
      [41, 2],
      [41, 3],
    ]);
  });

  it("render as a normal exchange, after the line's eve facts", () => {
    const eve = {
      data: {
        data: { outcome: "completed", turnId: "t1" },
        type: "turn.settled",
      },
      index: 3,
      line: 41,
      type: "turn.settled",
    };
    const view = toChatView([eve, ...rows], new Map(), new Map());
    expect(view.working).toBe(false);
    expect(view.items.map((i) => [i.kind, "text" in i ? i.text : ""])).toEqual([
      ["user", "hola"],
      ["bot", "¡Hola!"],
    ]);
  });

  it("show streaming deltas inside the opened turn", () => {
    const view = toChatView(
      fastOpeningRows(slot, id, "hola"),
      new Map([[`fast-${id}:reply`, "¡Ho"]]),
      new Map()
    );
    expect(view.working).toBe(true);
    expect(view.items.at(-1)).toMatchObject({
      kind: "bot",
      streaming: true,
      text: "¡Ho",
    });
  });
});

describe("pending fast context", () => {
  it("leaves the message context untouched without exchanges", () => {
    const context = { timeZone: "America/Argentina/Buenos_Aires" };
    expect(withFastExchanges(context, [])).toBe(context);
    expect(withFastExchanges(null, [])).toBeNull();
  });

  it("adds the exchanges eve never saw, oldest first", () => {
    expect(
      withFastExchanges({ timeZone: "UTC" }, [
        { reply: "¡Hola!", text: "hola" },
        { reply: "De nada", text: "gracias" },
      ])
    ).toMatchObject({
      recentQuickReplies: [
        { mati: "hola", you: "¡Hola!" },
        { mati: "gracias", you: "De nada" },
      ],
      timeZone: "UTC",
    });
  });
});

describe("routeFast wide mode", () => {
  it("lets action words through but still keeps files, links and long texts off", () => {
    const wide = (text: string, fileIds: string[] = []) =>
      routeFast({ fileIds, mode: "wide", text });
    expect(wide("Search my notes and tell me what's next")).toEqual({
      fast: true,
    });
    expect(routeFast({ fileIds: [], text: "Search my notes" })).toEqual({
      fast: false,
      reason: "action",
    });
    expect(wide("look at https://example.com")).toEqual({
      fast: false,
      reason: "url",
    });
    expect(wide("hi", ["file-1"])).toEqual({ fast: false, reason: "files" });
    expect(wide("x".repeat(2001))).toEqual({ fast: false, reason: "long" });
    expect(wide("x".repeat(1500))).toEqual({ fast: true });
  });
});

describe("fast path ack (FAST_PATH_ACK)", () => {
  const slot = { index: FAST_INDEX_BASE, line: 41 };
  const id = "22222222-2222-4222-8222-222222222222";
  const ackRows = fastAckRows(slot, id, "buscá vuelos", "Busco vuelos.", "d-1");
  const fact = (line: number, type: string, data: Record<string, unknown>) => ({
    data: { data, type },
    index: 0,
    line,
    type,
  });
  const eve = [
    fact(42, "delivery.consumed", {
      deliveryId: "d-1",
      parts: [{ kind: "text", text: "buscá vuelos" }],
    }),
    fact(43, "turn.started", { turnId: "t2" }),
  ];
  const shown = (rows: Parameters<typeof toChatView>[0]) =>
    toChatView(rows, new Map(), new Map()).items.map((i) => [
      i.kind,
      "text" in i ? i.text : "",
    ]);

  it("is off unless set to 1", () => {
    expect(fastAckEnabled(undefined)).toBe(false);
    expect(fastAckEnabled("0")).toBe(false);
    expect(fastAckEnabled("1")).toBe(true);
  });

  it("asks for one short line before escalating only when on", () => {
    const bot = { description: "", instructions: "", name: "Ana" };
    expect(fastSystemPrompt(bot, null, "")).toContain(
      "call `escalate` right away, before writing anything"
    );
    const ack = fastSystemPrompt(bot, null, "", true);
    expect(ack).toContain("ONE short sentence (at most 15 words");
    expect(ack).toContain("then call `escalate`");
    expect(ack).not.toContain("right away, before writing anything");
  });

  it("stores the user's message under eve's delivery id and leaves the turn running", () => {
    expect(ackRows.map((r) => [r.type, r.index - FAST_INDEX_BASE])).toEqual([
      ["delivery.consumed", 0],
      ["turn.started", 1],
      ["content.completed", 2],
    ]);
    expect(ackRows[0]?.data.data).toMatchObject({ deliveryId: "d-1" });
  });

  it("shows the user's message once, above the ack, while eve works", () => {
    const rows = [...ackRows, ...eve];
    const view = toChatView(rows, new Map(), new Map());
    expect(shown(rows)).toEqual([
      ["user", "buscá vuelos"],
      ["bot", "Busco vuelos."],
    ]);
    expect(view.working).toBe(true);
    // Before eve's facts arrive too: the ack's turn alone keeps it working.
    expect(waitStage(ackRows, [], true)).toMatchObject({ stage: "thinking" });
    expect(toChatView(ackRows, new Map(), new Map()).working).toBe(true);
  });

  it("ends like a normal turn once eve settles, same order on reload", () => {
    const rows = [
      ...ackRows,
      ...eve,
      fact(44, "content.completed", {
        kind: "text",
        partId: "r",
        phase: "reply",
        value: "Encontré 3 vuelos.",
      }),
      fact(45, "turn.settled", { outcome: "completed", turnId: "t2" }),
    ];
    const view = toChatView(rows.toReversed(), new Map(), new Map());
    expect(view.working).toBe(false);
    expect(shown(rows.toReversed())).toEqual([
      ["user", "buscá vuelos"],
      ["bot", "Busco vuelos."],
      ["bot", "Encontré 3 vuelos."],
    ]);
  });

  it("gives the bot the ack with this message only", () => {
    expect(withFastAck({ timeZone: "UTC" }, undefined)).toEqual({
      timeZone: "UTC",
    });
    expect(withFastAck(null, "Busco vuelos.")).toMatchObject({
      quickAck: "Busco vuelos.",
    });
  });
});

describe("routeFast with acks", () => {
  it("sends files and links to the fast path only to acknowledge them", () => {
    const wide = { ack: true, mode: "wide" };
    expect(
      routeFast({ ...wide, fileIds: ["f1"], text: "revisá esto" })
    ).toEqual({ fast: true, mustEscalate: "files" });
    expect(
      routeFast({ ...wide, fileIds: [], text: "abrí example.com" })
    ).toEqual({ fast: true, mustEscalate: "url" });
    // Without acks, or outside wide mode, they stay on the normal path.
    expect(
      routeFast({ ack: false, fileIds: ["f1"], mode: "wide", text: "x" })
    ).toEqual({ fast: false, reason: "files" });
    expect(
      routeFast({
        ack: true,
        fileIds: [],
        mode: undefined,
        text: "example.com",
      })
    ).toEqual({ fast: false, reason: "url" });
  });
});
