import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getRuntime } from "./app/api/bot/capabilities/route";
import {
  DELETE as deleteCapability,
  PATCH as patchCapability,
} from "./app/api/bots/[slug]/capabilities/[id]/route";
import {
  GET as getCapabilities,
  POST as postCapability,
} from "./app/api/bots/[slug]/capabilities/route";

const mocks = vi.hoisted(() => ({
  botFromRequest: vi.fn(),
  createCapability: vi.fn(),
  getBot: vi.fn(),
  listCapabilities: vi.fn(),
  publicCapability: vi.fn((row: unknown) => row),
  removeCapability: vi.fn(),
  runtimeSkills: vi.fn(),
  updateCapability: vi.fn(),
}));

vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.botFromRequest }));
vi.mock("@/lib/capabilities/store", () => ({
  createCapability: mocks.createCapability,
  listCapabilities: mocks.listCapabilities,
  publicCapability: mocks.publicCapability,
  removeCapability: mocks.removeCapability,
  runtimeSkills: mocks.runtimeSkills,
  updateCapability: mocks.updateCapability,
}));

const alpha = { id: "bot-alpha", slug: "alpha" };
const valid = {
  description: "Research workflow",
  kind: "skill",
  name: "research-kit",
  skills: [
    {
      content: "Use sources.",
      description: "Research",
      files: {},
      name: "research",
    },
  ],
};
const id = "11111111-1111-4111-8111-111111111111";
const ctx = (slug = "alpha") => ({ params: Promise.resolve({ slug }) });
const req = (body: unknown, method = "POST") =>
  new Request("http://busy.test/api/capabilities", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBot.mockImplementation(async (slug: string) =>
    slug === alpha.slug ? alpha : undefined
  );
  mocks.botFromRequest.mockResolvedValue({ slug: alpha.slug });
  mocks.listCapabilities.mockResolvedValue([]);
  mocks.createCapability.mockResolvedValue({
    id,
    ...valid,
    enabled: true,
    version: null,
  });
  mocks.updateCapability.mockResolvedValue({
    id,
    ...valid,
    enabled: true,
    version: null,
  });
  mocks.removeCapability.mockResolvedValue(undefined);
  mocks.runtimeSkills.mockResolvedValue([
    {
      content: "Use sources.",
      description: "Research",
      files: {},
      name: "s_0123456789abcdef_research",
    },
  ]);
});

describe("capability routes", () => {
  it("returns the bot capability list and no-store cache policy", async () => {
    const response = await getCapabilities(
      new Request("http://busy.test"),
      ctx()
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ capabilities: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404 for an unknown bot and 400 for invalid input", async () => {
    const missing = await getCapabilities(
      new Request("http://busy.test"),
      ctx("missing")
    );
    expect(missing.status).toBe(404);
    const invalid = await postCapability(req({ ...valid, extra: true }), ctx());
    expect(invalid.status).toBe(400);
    expect(mocks.createCapability).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized capability payload", async () => {
    const response = await postCapability(
      req({ ...valid, description: "x".repeat(600_000) }),
      ctx()
    );
    expect(response.status).toBe(413);
    expect(mocks.createCapability).not.toHaveBeenCalled();
  });

  it("creates, edits, toggles, and deletes using the owning bot id", async () => {
    const created = await postCapability(req(valid), ctx());
    expect(created.status).toBe(201);
    expect(mocks.createCapability).toHaveBeenCalledWith(valid);

    const edited = await patchCapability(
      req({ ...valid, description: "Updated" }, "PATCH"),
      { params: Promise.resolve({ id, slug: alpha.slug }) }
    );
    expect(edited.status).toBe(200);
    expect(mocks.updateCapability).toHaveBeenCalledWith(id, {
      ...valid,
      description: "Updated",
    });

    const toggled = await patchCapability(req({ enabled: false }, "PATCH"), {
      params: Promise.resolve({ id, slug: alpha.slug }),
    });
    expect(toggled.status).toBe(200);
    expect(mocks.updateCapability).toHaveBeenCalledWith(id, { enabled: false });

    const deleted = await deleteCapability(
      new Request("http://busy.test", { method: "DELETE" }),
      { params: Promise.resolve({ id, slug: alpha.slug }) }
    );
    expect(deleted.status).toBe(204);
    expect(mocks.removeCapability).toHaveBeenCalledWith(id);
  });

  it("does not query a bot when OIDC authentication fails", async () => {
    mocks.botFromRequest.mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );
    const response = await getRuntime(new Request("http://busy.test"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(mocks.runtimeSkills).not.toHaveBeenCalled();
  });

  it("returns only the runtime skills selected by the bot store", async () => {
    const response = await getRuntime(new Request("http://busy.test"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      skills: [
        {
          content: "Use sources.",
          description: "Research",
          files: {},
          name: "s_0123456789abcdef_research",
        },
      ],
    });
    expect(mocks.runtimeSkills).toHaveBeenCalledWith();
  });
});
