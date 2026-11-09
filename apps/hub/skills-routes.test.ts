import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as install } from "./app/api/bots/[slug]/skills/route";
import { GET as preview } from "./app/api/skills/preview/route";
import { GET as search } from "./app/api/skills/search/route";
import { SkillsChangedError, SkillsRateLimitError } from "./lib/skills/catalog";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  installSkillForBot: vi.fn(),
  previewSkill: vi.fn(),
  searchSkills: vi.fn(),
}));

vi.mock("@/lib/skills/catalog", () => {
  class SkillsValidationError extends Error {}
  class SkillsUnavailableError extends Error {}
  class SkillsNotFoundError extends Error {}
  class MockSkillsChangedError extends Error {}
  class MockSkillsSnapshotUnavailableError extends Error {}
  class MockSkillsRateLimitError extends Error {
    readonly retryAfter: string | null;
    constructor(message: string, retryAfter: string | null) {
      super(message);
      this.retryAfter = retryAfter;
    }
  }
  return {
    ...mocks,
    SkillsChangedError: MockSkillsChangedError,
    SkillsNotFoundError,
    SkillsRateLimitError: MockSkillsRateLimitError,
    SkillsSnapshotUnavailableError: MockSkillsSnapshotUnavailableError,
    SkillsUnavailableError,
    SkillsValidationError,
  };
});
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));

const bot = { id: "bot-alpha", slug: "alpha" };
const id = "vercel-labs/skills/find-skills";
const hash = "a".repeat(64);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBot.mockResolvedValue(bot);
  mocks.searchSkills.mockResolvedValue([
    {
      id,
      installs: 10,
      name: "find-skills",
      slug: "find-skills",
      source: "vercel-labs/skills",
      url: `https://skills.sh/${id}`,
    },
  ]);
  mocks.previewSkill.mockResolvedValue({
    capability: {
      description: "Find skills",
      kind: "skill",
      name: "find-skills-aaaaaaaaaa",
      skills: [
        {
          content: "Search.",
          description: "Find skills",
          files: {},
          name: "find-skills",
        },
      ],
      version: hash,
    },
    hash,
    origin: { hash, id, registry: "skills.sh" },
    skill: {
      files: [],
      hash,
      id,
      installs: 10,
      name: "find-skills",
      slug: "find-skills",
      source: "vercel-labs/skills",
      url: `https://skills.sh/${id}`,
    },
  });
  mocks.installSkillForBot.mockResolvedValue({
    capability: { id: "cap-1" },
    hash,
    reused: false,
  });
});

describe("skills catalog routes", () => {
  it("returns search and preview projections", async () => {
    const searchResponse = await search(
      new Request("http://busy.test/api/skills/search?q=react&limit=5")
    );
    expect(searchResponse.status).toBe(200);
    expect(await searchResponse.json()).toEqual({
      skills: [
        {
          id,
          installs: 10,
          name: "find-skills",
          slug: "find-skills",
          source: "vercel-labs/skills",
          url: `https://skills.sh/${id}`,
        },
      ],
    });
    const previewResponse = await preview(
      new Request(
        `http://busy.test/api/skills/preview?id=${encodeURIComponent(id)}`
      )
    );
    expect(previewResponse.status).toBe(200);
    expect((await previewResponse.json()).hash).toBe(hash);
  });

  it("returns 409 when the reviewed snapshot changed", async () => {
    mocks.installSkillForBot.mockRejectedValue(
      new SkillsChangedError("changed")
    );
    const response = await install(
      new Request("http://busy.test", {
        body: JSON.stringify({ hash, id }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "alpha" }) }
    );
    expect(response.status).toBe(409);
  });

  it("preserves Retry-After on catalog rate limits", async () => {
    mocks.searchSkills.mockRejectedValue(
      new SkillsRateLimitError("rate limited", "19")
    );
    const response = await search(
      new Request("http://busy.test/api/skills/search?q=react")
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("19");
  });
});
