import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defined } from "../test-utils";
import {
  acceptsLegacyPeerOidc,
  clearConsultationCredentialCache,
  consultationAuth,
  sendsConsultationCredentials,
} from "./consultation-auth";

// H-26: the asking bot's outbound auth for one peer. eve calls it before every request to that
// peer, including follow-ups rebuilt after a runtime restart, so it must mint, rotate and recover
// without any memo.

const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("./hub", () => ({ hubFetch }));

const PEER_ID = "22222222-2222-4222-8222-222222222222";
let clock = 1_900_000_000_000;
const now = () => clock;
let minted = 0;
const issue = () => {
  minted += 1;
  return Response.json({
    expiresAt: clock + 5 * 60_000,
    to: PEER_ID,
    token: `token-${minted}`,
  });
};

beforeEach(() => {
  clearConsultationCredentialCache();
  hubFetch.mockReset();
  minted = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("consultation credential outbound auth", () => {
  it("asks the hub for this peer only and sends the result as the bearer", async () => {
    const fetcher = vi.fn(async () => await Promise.resolve(issue()));
    const auth = consultationAuth(PEER_ID, fetcher, now);
    await expect(auth()).resolves.toEqual({
      headers: { authorization: "Bearer token-1" },
    });
    const [path, init] = defined(fetcher.mock.calls[0]) as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/api/bot/consultations/credential");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ to: PEER_ID });
  });

  it("reuses a fresh credential, rotates it before expiry, and survives a rebuild", async () => {
    const fetcher = vi.fn(async () => await Promise.resolve(issue()));
    const first = consultationAuth(PEER_ID, fetcher, now);
    await first();
    clock += 60_000;
    // A follow-up after eve rebuilt the remote agent: a new auth function, same peer.
    const rebuilt = consultationAuth(PEER_ID, fetcher, now);
    await expect(rebuilt()).resolves.toEqual({
      headers: { authorization: "Bearer token-1" },
    });
    clock += 4 * 60_000; // inside the one-minute refresh margin
    await expect(rebuilt()).resolves.toEqual({
      headers: { authorization: "Bearer token-2" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails the request when the hub refuses, then retries on the next request", async () => {
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("no", { status: 403 }))
      .mockImplementation(async () => await Promise.resolve(issue()));
    const auth = consultationAuth(PEER_ID, fetcher, now);
    await expect(auth()).rejects.toThrow("403");
    await expect(auth()).resolves.toEqual({
      headers: { authorization: "Bearer token-1" },
    });
  });

  it("rejects a malformed hub answer", async () => {
    const auth = consultationAuth(
      PEER_ID,
      async () => await Promise.resolve(Response.json({ token: 42 })),
      now
    );
    await expect(auth()).rejects.toThrow("invalid");
  });
});

describe("transition switches", () => {
  it("sends OIDC and accepts legacy peers until each switch is set", () => {
    expect(sendsConsultationCredentials({})).toBe(false);
    expect(
      sendsConsultationCredentials({ BUSY_CONSULTATION_CREDENTIALS: "1" })
    ).toBe(true);
    expect(acceptsLegacyPeerOidc({})).toBe(true);
    expect(acceptsLegacyPeerOidc({ BUSY_LEGACY_PEER_OIDC: "off" })).toBe(false);
  });
});

describe("peer slots with credentials on", () => {
  const peer = {
    description: "Contracts.",
    id: PEER_ID,
    name: "Lawyer",
    slug: "lawyer",
    url: "https://lawyer.bots.example.com",
  };
  async function slotAuth(principalId = "busy-hub:hub") {
    vi.resetModules();
    const { peerSlot } = await import("./peers");
    const slot = peerSlot(1) as unknown as Record<
      symbol,
      (ctx: unknown) => Promise<{ auth?: () => Promise<unknown> } | null>
    >;
    return await defined(slot[Symbol.for("eve.dynamic")])({
      session: {
        auth: { current: { principalId, principalType: "service" } },
        id: "s",
      },
    });
  }

  it("sends a hub credential for the peer's id instead of the bot's OIDC", async () => {
    vi.stubEnv("BUSY_CONSULTATION_CREDENTIALS", "1");
    hubFetch.mockImplementation(async (path) => {
      await Promise.resolve();
      return path === "/api/bot/directory" ? Response.json([peer]) : issue();
    });
    const agent = defined(await slotAuth());
    await expect(defined(agent.auth)()).resolves.toEqual({
      headers: { authorization: "Bearer token-1" },
    });
    expect(hubFetch).toHaveBeenCalledWith(
      "/api/bot/consultations/credential",
      expect.objectContaining({ body: JSON.stringify({ to: PEER_ID }) })
    );
  });

  it("offers no peer at all to a hub-signed consultation (one hop)", async () => {
    vi.stubEnv("BUSY_CONSULTATION_CREDENTIALS", "1");
    hubFetch.mockResolvedValue(Response.json([peer]));
    expect(
      await slotAuth(`busy-hub:consultation:${PEER_ID}:${PEER_ID}`)
    ).toBeNull();
    expect(hubFetch).not.toHaveBeenCalled();
  });
});
