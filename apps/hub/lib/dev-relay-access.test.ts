import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeDevRelay } from "./dev-relay-access";

const verifyHubRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oidc", () => ({ verifyHubRequest }));

const token = "synthetic-development-oidc";
const hash = createHash("sha256").update(token).digest("hex");
const request = (authorization = `Bearer ${token}`) =>
  new Request("http://hub.test/api/dev/bots/lawyer/eve/v1/session/s1", {
    headers: { authorization },
  });
const env = {
  DEV_RELAY: "1",
  DEV_RELAY_TOKEN_SHA256: hash,
  DEV_RELAY_UNTIL: "2099-01-01T00:00:00.000Z",
  VERCEL_TEAM_SLUG: "test-team",
};

beforeEach(() => {
  vi.resetAllMocks();
  verifyHubRequest.mockResolvedValue(undefined);
});

describe("authorizeDevRelay", () => {
  it("accepts only a live grant, matching token hash and verified hub OIDC", async () => {
    await expect(
      authorizeDevRelay(request(), env, Date.parse("2026-11-02T00:00:00Z"))
    ).resolves.toBeNull();
    expect(verifyHubRequest).toHaveBeenCalledWith(expect.any(Request), {
      team: "test-team",
    });
  });

  it.each([
    ["disabled", { ...env, DEV_RELAY: "0" }],
    ["missing expiry", { ...env, DEV_RELAY_UNTIL: undefined }],
    ["expired", { ...env, DEV_RELAY_UNTIL: "2020-01-01T00:00:00.000Z" }],
    ["invalid hash", { ...env, DEV_RELAY_TOKEN_SHA256: "not-a-sha256" }],
  ])("returns 404 for %s configuration", async (_name, config) => {
    const response = await authorizeDevRelay(
      request(),
      config,
      Date.parse("2026-11-02T00:00:00Z")
    );
    expect(response?.status).toBe(404);
    expect(verifyHubRequest).not.toHaveBeenCalled();
  });

  it("returns 401 for missing or nonmatching credentials", async () => {
    expect((await authorizeDevRelay(request(""), env))?.status).toBe(401);
    expect(
      (await authorizeDevRelay(request("Bearer another-token"), env))?.status
    ).toBe(401);
    expect(verifyHubRequest).not.toHaveBeenCalled();
  });

  it("returns 401 when the matching token fails OIDC verification", async () => {
    verifyHubRequest.mockRejectedValue(new Error("expired"));
    const response = await authorizeDevRelay(request(), env);
    expect(response?.status).toBe(401);
  });
});
