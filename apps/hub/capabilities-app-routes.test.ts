import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, PATCH } from "./app/api/capabilities/[id]/route";
import { GET, POST } from "./app/api/capabilities/route";
import { POST as install } from "./app/api/skills/route";

const mocks = vi.hoisted(() => ({
  createCapability: vi.fn(),
  installSkillForBot: vi.fn(),
  listCapabilities: vi.fn(),
  publicCapability: vi.fn((row: unknown) => row),
  removeCapability: vi.fn(),
  updateCapability: vi.fn(),
}));

vi.mock("@/lib/capabilities/store", () => ({
  createCapability: mocks.createCapability,
  listCapabilities: mocks.listCapabilities,
  publicCapability: mocks.publicCapability,
  removeCapability: mocks.removeCapability,
  updateCapability: mocks.updateCapability,
}));
vi.mock("@/lib/skills/catalog", () => ({
  installInputSchema: {
    safeParse: (value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        !("hash" in value)
      ) {
        return { success: false };
      }
      return { data: value, success: true };
    },
  },
  installSkillForBot: mocks.installSkillForBot,
}));

const capability = {
  description: "Research",
  enabled: true,
  id: "11111111-1111-4111-8111-111111111111",
  kind: "skill",
  name: "research",
  skills: [
    {
      content: "Use sources.",
      description: "Research",
      files: {},
      name: "research",
    },
  ],
  version: null,
};

const request = (body: unknown, method = "POST") =>
  new Request("https://busy.test/api/capabilities", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listCapabilities.mockResolvedValue([]);
  mocks.createCapability.mockResolvedValue(capability);
  mocks.updateCapability.mockResolvedValue(capability);
  mocks.removeCapability.mockResolvedValue(undefined);
  mocks.installSkillForBot.mockResolvedValue({
    capability,
    hash: "a".repeat(64),
    reused: false,
  });
});

describe("app capability routes", () => {
  it("lists and creates without receiving a bot scope", async () => {
    expect(await (await GET()).json()).toEqual({ capabilities: [] });
    await POST(
      request({
        description: "Research",
        kind: "skill",
        name: "research",
        skills: capability.skills,
      })
    );
    expect(mocks.createCapability).toHaveBeenCalledWith(
      expect.objectContaining({ name: "research" })
    );
  });

  it("edits and removes by app capability id", async () => {
    await PATCH(request({ enabled: false }, "PATCH"), {
      params: Promise.resolve({ id: capability.id }),
    });
    expect(mocks.updateCapability).toHaveBeenCalledWith(capability.id, {
      enabled: false,
    });
    await DELETE(new Request("https://busy.test", { method: "DELETE" }), {
      params: Promise.resolve({ id: capability.id }),
    });
    expect(mocks.removeCapability).toHaveBeenCalledWith(capability.id);
  });

  it("installs reviewed skills globally", async () => {
    const response = await install(
      request({ hash: "a".repeat(64), id: "vercel-labs/skills/research" })
    );
    expect(response.status).toBe(201);
    expect(mocks.installSkillForBot).toHaveBeenCalledWith({
      hash: "a".repeat(64),
      id: "vercel-labs/skills/research",
    });
  });
});
