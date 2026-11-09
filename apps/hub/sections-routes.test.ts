import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUT as putBotSection } from "./app/api/bots/[slug]/section/route";
import {
  DELETE as deleteSection,
  PATCH as patchSection,
} from "./app/api/sections/[id]/route";
import {
  GET as getSections,
  POST as postSection,
} from "./app/api/sections/route";
import {
  BotNotFoundError,
  SectionConflictError,
  SectionNotFoundError,
} from "./lib/sections/types";
import { MAX_SECTION_JSON_BYTES } from "./lib/sections/validation";

const mocks = vi.hoisted(() => ({
  createSection: vi.fn(),
  deleteSection: vi.fn(),
  listSections: vi.fn(),
  setBotSection: vi.fn(),
  updateSection: vi.fn(),
}));

vi.mock("@/lib/sections/store", () => mocks);

const id = "11111111-1111-4111-8111-111111111111";
const bot = "assistant";
const section = { botSlugs: [bot], id, name: "Documents" };
const ctx = (sectionId = id) => ({
  params: Promise.resolve({ id: sectionId }),
});
const botCtx = (slug = bot) => ({ params: Promise.resolve({ slug }) });
const req = (body: unknown, method = "POST") =>
  rawReq(JSON.stringify(body), method);
const rawReq = (
  body: BodyInit | null,
  method = "POST",
  extraHeaders: Record<string, string> = {}
) =>
  new Request("http://busy.test/api/sections", {
    body,
    headers: { "content-type": "application/json", ...extraHeaders },
    method,
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listSections.mockResolvedValue([section]);
  mocks.createSection.mockResolvedValue(section);
  mocks.updateSection.mockResolvedValue({ ...section, name: "DNC" });
  mocks.deleteSection.mockResolvedValue(undefined);
  mocks.setBotSection.mockResolvedValue(undefined);
});

describe("section routes", () => {
  it("lists sections with bot slugs and a private no-store cache policy", async () => {
    const response = await getSections();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ sections: [section] });
  });

  it("trims valid names and rejects unknown fields or oversized JSON", async () => {
    const created = await postSection(req({ name: "  Documents  " }));
    expect(created.status).toBe(201);
    expect(mocks.createSection).toHaveBeenCalledWith("Documents");

    const extra = await postSection(req({ extra: true, name: "Documents" }));
    expect(extra.status).toBe(400);
    expect(mocks.createSection).toHaveBeenCalledOnce();

    const oversized = await postSection(req({ name: "x".repeat(17_001) }));
    expect(oversized.status).toBe(413);
    expect(mocks.createSection).toHaveBeenCalledOnce();
  });

  it("maps duplicate names, missing sections and unexpected failures", async () => {
    mocks.createSection.mockRejectedValueOnce(new SectionConflictError());
    const duplicate = await postSection(req({ name: "documents" }));
    expect(duplicate.status).toBe(409);

    mocks.updateSection.mockRejectedValueOnce(new SectionNotFoundError());
    const missing = await patchSection(req({ name: "DNC" }, "PATCH"), ctx());
    expect(missing.status).toBe(404);

    mocks.deleteSection.mockRejectedValueOnce(new Error("database password"));
    const failed = await deleteSection(
      new Request("http://busy.test", { method: "DELETE" }),
      ctx()
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: "Could not update sections.",
    });
  });

  it("rejects malformed JSON, null names, invalid UUIDs, and sanitized list failures", async () => {
    expect((await postSection(rawReq("{"))).status).toBe(400);
    expect((await postSection(req({ name: null }))).status).toBe(400);
    expect(
      (await patchSection(req({ name: "DNC" }, "PATCH"), ctx("invalid"))).status
    ).toBe(400);

    mocks.listSections.mockRejectedValueOnce(
      new Error("DATABASE_URL=super-secret")
    );
    const failed = await getSections();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: "Could not update sections.",
    });
  });

  it("rejects declared and streamed payloads before parsing or writing", async () => {
    const declared = await postSection(
      rawReq("{}", "POST", {
        "content-length": String(MAX_SECTION_JSON_BYTES + 1),
      })
    );
    expect(declared.status).toBe(413);

    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("x".repeat(MAX_SECTION_JSON_BYTES + 1))
        );
      },
    });
    const streamed = await postSection(
      new Request("http://busy.test/api/sections", {
        body: stream,
        duplex: "half",
        headers: { "content-type": "application/json" },
        method: "POST",
      } as RequestInit & { duplex: "half" })
    );
    expect(streamed.status).toBe(413);
    expect(canceled).toBe(true);
    expect(mocks.createSection).not.toHaveBeenCalled();
  });

  it("assigns a bot or clears it with a null section id", async () => {
    const assigned = await putBotSection(
      req({ sectionId: id }, "PUT"),
      botCtx()
    );
    expect(assigned.status).toBe(200);
    expect(mocks.setBotSection).toHaveBeenCalledWith(bot, id);

    const cleared = await putBotSection(
      req({ sectionId: null }, "PUT"),
      botCtx()
    );
    expect(cleared.status).toBe(200);
    expect(mocks.setBotSection).toHaveBeenLastCalledWith(bot, null);
  });

  it("returns 404 when assignment targets an unknown bot", async () => {
    mocks.setBotSection.mockRejectedValueOnce(new BotNotFoundError());
    const response = await putBotSection(
      req({ sectionId: id }, "PUT"),
      botCtx("missing")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Bot not found." });
  });
});
