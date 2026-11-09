import { beforeEach, expect, it as test, vi } from "vitest";

import { GET as preview } from "./app/api/bot/skills/preview/route";
import { POST as install } from "./app/api/bot/skills/route";
import { GET as search } from "./app/api/bot/skills/search/route";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getBot: vi.fn(),
  install: vi.fn(),
  preview: vi.fn(),
  search: vi.fn(),
}));
vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.auth }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/skills/catalog", async (original) => ({
  ...(await original<typeof import("@/lib/skills/catalog")>()),
  installSkillForBot: mocks.install,
  previewSkill: mocks.preview,
  searchSkills: mocks.search,
}));

const id = "vercel-labs/skills/find-skills";
const hash = "a".repeat(64);
const bodyRequest = (body: unknown) =>
  new Request("https://busy.test/api/bot/skills", {
    body: JSON.stringify(body),
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ slug: "researcher" });
  mocks.getBot.mockResolvedValue({ id: "owner-bot-id", slug: "researcher" });
  mocks.search.mockResolvedValue([{ id }]);
  mocks.preview.mockResolvedValue({ hash });
  mocks.install.mockResolvedValue({
    capability: { id: "capability-id" },
    hash,
    reused: false,
    row: { botId: "private-row" },
  });
});

test("rejects unauthenticated catalog access before querying any bot or external service", async () => {
  mocks.auth.mockResolvedValue(new Response(null, { status: 401 }));
  const responses = await Promise.all([
    search(new Request("https://busy.test/api/bot/skills/search?q=react")),
    preview(new Request(`https://busy.test/api/bot/skills/preview?id=${id}`)),
    install(bodyRequest({ hash, id })),
  ]);
  expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
  expect(mocks.getBot).not.toHaveBeenCalled();
  expect(mocks.search).not.toHaveBeenCalled();
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
});

test("requires the OIDC bot to be registered before allowing search or preview", async () => {
  mocks.getBot.mockResolvedValue(undefined);
  expect(
    (
      await search(
        new Request("https://busy.test/api/bot/skills/search?q=react")
      )
    ).status
  ).toBe(404);
  expect(mocks.search).not.toHaveBeenCalled();
});

test("keeps search and preview behind bot authentication and excludes internal rows", async () => {
  const found = await search(
    new Request(
      "https://busy.test/api/bot/skills/search?q=react&owner=vercel-labs&limit=5"
    )
  );
  expect(mocks.search).toHaveBeenCalledWith("react", "vercel-labs", 5);
  expect(await found.json()).toEqual({ skills: [{ id }] });
  const reviewed = await preview(
    new Request(`https://busy.test/api/bot/skills/preview?id=${id}`)
  );
  expect(mocks.preview).toHaveBeenCalledWith(id);
  expect(await reviewed.json()).toEqual({ hash });
  const installed = await install(bodyRequest({ hash, id }));
  expect(installed.status).toBe(201);
  expect(mocks.install).toHaveBeenCalledWith({ hash, id });
  expect(await installed.json()).toEqual({
    capability: { id: "capability-id" },
    hash,
    reused: false,
  });
  expect(installed.headers.get("cache-control")).toBe("no-store");
});

test("rejects caller-supplied ownership and invalid snapshot hashes", async () => {
  expect(
    (await install(bodyRequest({ botId: "another-bot", hash, id }))).status
  ).toBe(400);
  expect(
    (await install(bodyRequest({ hash: "not-a-sha256", id }))).status
  ).toBe(400);
  expect(mocks.install).not.toHaveBeenCalled();
});
