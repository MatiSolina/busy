import { beforeEach, expect, it as test, vi } from "vitest";
import { POST } from "./app/api/bot/skills/learned/route";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getBot: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.auth }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/skills/learned", async (original) => ({
  ...(await original<typeof import("@/lib/skills/learned")>()),
  saveLearnedSkill: mocks.save,
}));

const skill = {
  description: "Build the monthly report.",
  instructions: "1. Export.\n2. Group.\n3. Send it with send_file to the user.",
  name: "monthly-report",
};
const request = (body: unknown) =>
  new Request("https://busy.test/api/bot/skills/learned", {
    body: JSON.stringify(body),
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ slug: "researcher" });
  mocks.getBot.mockResolvedValue({ id: "bot-id", slug: "researcher" });
  mocks.save.mockResolvedValue({
    capability: { id: "c" },
    created: true,
    loadName: "s_x_monthly-report",
  });
});

test("saves only for a registered bot, with nothing taken from the body but the skill", async () => {
  const response = await POST(request({ ...skill }));
  expect(response.status).toBe(201);
  expect(mocks.save).toHaveBeenCalledWith({ ...skill, edit: false });
});

test("rejects an unauthenticated caller and a malformed skill before saving", async () => {
  mocks.auth.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect((await POST(request(skill))).status).toBe(401);
  expect((await POST(request({ ...skill, botId: "other" }))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});
