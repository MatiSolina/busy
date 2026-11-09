import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RoutineConflictError,
  RoutineNotFoundError,
} from "@/lib/routines/types";
import {
  DELETE as deleteBotApi,
  PATCH as patchBotApi,
} from "./app/api/bot/routines/[id]/route";
import {
  GET as getBotApi,
  POST as postBotApi,
} from "./app/api/bot/routines/route";
import {
  DELETE as deleteUi,
  PATCH as patchUi,
} from "./app/api/bots/[slug]/routines/[id]/route";
import {
  GET as getUi,
  POST as postUi,
} from "./app/api/bots/[slug]/routines/route";

const h = vi.hoisted(() => ({
  botFromRequest: vi.fn(),
  createRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  getBot: vi.fn(),
  listRoutines: vi.fn(),
  updateRoutine: vi.fn(),
}));

vi.mock("@/lib/bot-auth", () => ({ botFromRequest: h.botFromRequest }));
vi.mock("@/lib/bots/service", () => ({ getBot: h.getBot }));
vi.mock("@/lib/routines/store", () => ({
  createRoutine: h.createRoutine,
  deleteRoutine: h.deleteRoutine,
  listRoutines: h.listRoutines,
  updateRoutine: h.updateRoutine,
}));

const id = "11111111-1111-4111-8111-111111111111";
const bot = { id: "bot-1", slug: "lawyer" };
const routine = {
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
  id,
  lastRun: null,
  name: "Morning brief",
  prompt: "Review updates and send a brief.",
  time: "09:00",
  timeZone: "America/Argentina/Cordoba",
};

const ctxUi = () => ({ params: Promise.resolve({ slug: bot.slug }) });
const ctxUiDetail = () => ({ params: Promise.resolve({ id, slug: bot.slug }) });
const ctxBot = () => ({ params: Promise.resolve({ id }) });
const req = (
  method: string,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  new Request("https://busy.test/api/routines", {
    headers:
      body === undefined
        ? headers
        : { "content-type": "application/json", ...headers },
    method,
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  h.botFromRequest.mockResolvedValue({ slug: bot.slug });
  h.getBot.mockResolvedValue(bot);
  h.listRoutines.mockResolvedValue([routine]);
  h.createRoutine.mockResolvedValue(routine);
  h.updateRoutine.mockResolvedValue({ ...routine, enabled: false });
  h.deleteRoutine.mockResolvedValue(undefined);
});

describe("UI routine routes", () => {
  it("lists routines for the requested bot with private no-store JSON", async () => {
    const response = await getUi(req("GET"), ctxUi());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ routines: [routine] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.listRoutines).toHaveBeenCalledWith(bot.id);
  });

  it("returns 404 without touching the store for an unknown bot", async () => {
    h.getBot.mockResolvedValue(undefined);
    const response = await getUi(req("GET"), ctxUi());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Bot not found." });
    expect(h.listRoutines).not.toHaveBeenCalled();
  });

  it("validates and creates without accepting botId from the body", async () => {
    const response = await postUi(
      req("POST", {
        botId: "other-bot",
        id,
        name: "  Morning brief ",
        prompt: " Review updates and send a brief. ",
        time: "09:00",
        timeZone: "America/Argentina/Cordoba",
      }),
      ctxUi()
    );
    expect(response.status).toBe(400);
    expect(h.createRoutine).not.toHaveBeenCalled();

    const ok = await postUi(
      req("POST", {
        id,
        name: "  Morning brief ",
        prompt: " Review updates and send a brief. ",
        time: "09:00",
        timeZone: "America/Argentina/Cordoba",
      }),
      ctxUi()
    );
    expect(ok.status).toBe(201);
    expect(h.createRoutine).toHaveBeenCalledWith(bot.id, {
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      id,
      name: "Morning brief",
      prompt: "Review updates and send a brief.",
      time: "09:00",
      timeZone: "America/Argentina/Cordoba",
    });
  });

  it("enforces the streamed body size limit before parsing", async () => {
    const response = await postUi(
      req("POST", JSON.stringify({ name: "x".repeat(40_000) })),
      ctxUi()
    );
    expect(response.status).toBe(413);
    expect(h.createRoutine).not.toHaveBeenCalled();
  });

  it("maps ownership, conflicts, and unexpected store errors", async () => {
    h.updateRoutine.mockRejectedValueOnce(new RoutineNotFoundError());
    expect(
      (await patchUi(req("PATCH", { enabled: false }), ctxUiDetail())).status
    ).toBe(404);
    h.updateRoutine.mockRejectedValueOnce(
      new RoutineConflictError("An enabled routine already uses this time.")
    );
    const conflict = await patchUi(
      req("PATCH", { enabled: false }),
      ctxUiDetail()
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "An enabled routine already uses this time.",
    });
    h.updateRoutine.mockRejectedValueOnce(new Error("password=secret"));
    const failure = await patchUi(
      req("PATCH", { enabled: false }),
      ctxUiDetail()
    );
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({
      error: "Routine operation failed.",
    });
  });

  it("deletes with a JSON acknowledgement", async () => {
    const response = await deleteUi(req("DELETE"), ctxUiDetail());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.deleteRoutine).toHaveBeenCalledWith(bot.id, id);
  });
});

describe("bot-authenticated routine routes", () => {
  it("authenticates before looking up the bot and returns JSON no-store unauthorized", async () => {
    h.botFromRequest.mockResolvedValue(
      new Response("not authorized", { status: 401 })
    );
    const response = await getBotApi(req("GET"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.getBot).not.toHaveBeenCalled();
  });

  it("looks up the caller's own bot and lists routines", async () => {
    const response = await getBotApi(req("GET"));
    expect(response.status).toBe(200);
    expect(h.getBot).toHaveBeenCalledWith(bot.slug);
    expect(h.listRoutines).toHaveBeenCalledWith(bot.id);
  });

  it("does not parse a body before auth and rejects invalid authenticated payloads", async () => {
    h.botFromRequest.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await postBotApi(req("POST", `{${"x".repeat(50_000)}`));
    expect(h.getBot).not.toHaveBeenCalled();

    const response = await postBotApi(
      req("POST", {
        botId: "other",
        id,
        name: "bad",
        prompt: "bad",
        time: "09:00",
        timeZone: "UTC",
      })
    );
    expect(response.status).toBe(400);
    expect(h.createRoutine).not.toHaveBeenCalled();
  });

  it("updates and deletes only the authenticated bot's routine", async () => {
    const patch = await patchBotApi(req("PATCH", { enabled: false }), ctxBot());
    expect(patch.status).toBe(200);
    expect(h.updateRoutine).toHaveBeenCalledWith(bot.id, id, {
      enabled: false,
    });
    const deleted = await deleteBotApi(req("DELETE"), ctxBot());
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(h.deleteRoutine).toHaveBeenCalledWith(bot.id, id);
  });

  it("returns 404 for a routine owned by another bot", async () => {
    h.deleteRoutine.mockRejectedValue(new RoutineNotFoundError());
    const response = await deleteBotApi(req("DELETE"), ctxBot());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Routine not found." });
  });
});
