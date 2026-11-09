import { describe, expect, it, vi } from "vitest";
import { accountSnapshot } from "./account";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("account snapshot", () => {
  it("uses Vercel profile data and reports Token Pass usage for the current billing period", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          user: {
            avatar: "avatar-hash",
            name: "The user Solina",
            username: "matisolina",
          },
        })
      )
      .mockResolvedValueOnce(
        response({
          billing: {
            invoiceItems: { tokenPass: { quantity: 1 } },
            period: {
              end: Date.parse("2026-11-10T08:00:00Z"),
              start: Date.parse("2026-10-10T07:00:00Z"),
            },
          },
          id: "team-id",
          slug: "mati-solina",
        })
      )
      .mockResolvedValueOnce(
        response({
          results: [
            { hour: "2026-10-30 02:00:00", total_cost: 8.4 },
            // The reporting API's end_date is inclusive, so the service filters
            // this row out because it is after the billing period's exact end.
            { hour: "2026-11-10 08:00:00", total_cost: 99 },
          ],
        })
      );

    const snapshot = await accountSnapshot(
      "fallback",
      { VERCEL_TEAM_ID: "team-id", VERCEL_TOKEN: "server-token" },
      fetchImpl,
      new Date("2026-11-02T12:00:00Z"),
      async () => "team-oidc-token"
    );
    expect(snapshot).toEqual({
      account: {
        avatarUrl: "https://api.vercel.com/www/avatar/avatar-hash",
        name: "The user Solina",
        username: "matisolina",
      },
      tokenPass: {
        dashboardUrl: "https://vercel.com/mati-solina/~/ai-gateway/token-pass",
        limitUsd: 80,
        percentUsed: 10.5,
        resetsAt: "2026-11-10T08:00:00.000Z",
        status: "active",
        usedUsd: 8.4,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const profileHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const reportHeaders = fetchImpl.mock.calls[2]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(profileHeaders.Authorization).toBe("Bearer server-token");
    expect(reportHeaders.Authorization).toBe("Bearer team-oidc-token");
    const reportUrl = new URL(String(fetchImpl.mock.calls[2]?.[0]));
    expect(reportUrl.searchParams.get("group_by")).toBe("day");
    expect(reportUrl.searchParams.get("date_part")).toBe("hour");
    expect(reportUrl.searchParams.get("provider")).toBe("token-pass");
  });

  it("does not invent a percentage when the report is unavailable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ user: { name: "The user Solina" } }))
      .mockResolvedValueOnce(
        response({
          billing: {
            period: {
              end: Date.parse("2026-11-10T08:00:00Z"),
              start: Date.parse("2026-10-10T07:00:00Z"),
            },
          },
          id: "team-id",
          slug: "mati-solina",
        })
      )
      .mockResolvedValueOnce(response({ error: "not available" }, 403));

    const snapshot = await accountSnapshot(
      "mati",
      { VERCEL_TEAM_ID: "team-id", VERCEL_TOKEN: "server-token" },
      fetchImpl,
      new Date("2026-11-02T12:00:00Z"),
      async () => "team-oidc-token"
    );
    expect(snapshot.account.name).toBe("The user Solina");
    expect(snapshot.tokenPass.status).toBe("unavailable");
    expect(snapshot.tokenPass.percentUsed).toBeNull();
    expect(snapshot.tokenPass.usedUsd).toBeNull();
  });

  it("reports a real zero when Token Pass is active but no hourly usage rows exist", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ user: { name: "The user Solina" } }))
      .mockResolvedValueOnce(
        response({
          billing: {
            invoiceItems: { tokenPass: { quantity: 1 } },
            period: {
              end: Date.parse("2026-11-10T08:00:00Z"),
              start: Date.parse("2026-10-10T07:00:00Z"),
            },
          },
          id: "team-id",
          slug: "mati-solina",
        })
      )
      .mockResolvedValueOnce(response({ results: [] }));

    const snapshot = await accountSnapshot(
      "mati",
      { VERCEL_TEAM_ID: "team-id", VERCEL_TOKEN: "server-token" },
      fetchImpl,
      new Date("2026-11-02T12:00:00Z"),
      async () => "team-oidc-token"
    );
    expect(snapshot.tokenPass).toMatchObject({
      limitUsd: 80,
      percentUsed: 0,
      status: "active",
      usedUsd: 0,
    });
  });

  it("does not invent zero usage for an inactive team", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ user: { name: "The user Solina" } }))
      .mockResolvedValueOnce(
        response({
          billing: {
            invoiceItems: { tokenPass: { quantity: 0 } },
            period: {
              end: Date.parse("2026-11-10T08:00:00Z"),
              start: Date.parse("2026-10-10T07:00:00Z"),
            },
          },
          id: "team-id",
          slug: "mati-solina",
        })
      )
      .mockResolvedValueOnce(response({ results: [] }));

    const snapshot = await accountSnapshot(
      "mati",
      { VERCEL_TEAM_ID: "team-id", VERCEL_TOKEN: "server-token" },
      fetchImpl,
      new Date("2026-11-02T12:00:00Z"),
      async () => "team-oidc-token"
    );
    expect(snapshot.tokenPass.status).toBe("unavailable");
    expect(snapshot.tokenPass.percentUsed).toBeNull();
  });

  it("does not treat malformed report rows as valid zero or partial usage", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ user: { name: "The user Solina" } }))
      .mockResolvedValueOnce(
        response({
          billing: {
            invoiceItems: { tokenPass: { quantity: 1 } },
            period: {
              end: Date.parse("2026-11-10T08:00:00Z"),
              start: Date.parse("2026-10-10T07:00:00Z"),
            },
          },
          id: "team-id",
          slug: "mati-solina",
        })
      )
      .mockResolvedValueOnce(
        response({
          results: [
            { hour: "2026-10-30 02:00:00", total_cost: 8.4 },
            { hour: "not-a-date", total_cost: 1 },
          ],
        })
      );

    const snapshot = await accountSnapshot(
      "mati",
      { VERCEL_TEAM_ID: "team-id", VERCEL_TOKEN: "server-token" },
      fetchImpl,
      new Date("2026-11-02T12:00:00Z"),
      async () => "team-oidc-token"
    );
    expect(snapshot.tokenPass.status).toBe("unavailable");
    expect(snapshot.tokenPass.percentUsed).toBeNull();
    expect(snapshot.tokenPass.usedUsd).toBeNull();
  });

  it("does not use billing data returned for a different team", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ user: { name: "The user Solina" } }))
      .mockResolvedValueOnce(
        response({
          billing: {
            invoiceItems: { tokenPass: { quantity: 1 } },
            period: {
              end: Date.parse("2026-11-10T08:00:00Z"),
              start: Date.parse("2026-10-10T07:00:00Z"),
            },
          },
          id: "another-team",
          slug: "another-team",
        })
      );

    const snapshot = await accountSnapshot(
      "mati",
      { VERCEL_TEAM_ID: "team-id", VERCEL_TOKEN: "server-token" },
      fetchImpl,
      new Date("2026-11-02T12:00:00Z"),
      async () => "team-oidc-token"
    );
    expect(snapshot.tokenPass.percentUsed).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to the authenticated Busy user without server configuration", async () => {
    const snapshot = await accountSnapshot(
      "mati",
      { BUSY_DISPLAY_NAME: "Matias Solina" },
      vi.fn<typeof fetch>(),
      new Date("2026-11-02T12:00:00Z")
    );
    expect(snapshot.account).toEqual({
      avatarUrl: null,
      name: "Matias Solina",
      username: "mati",
    });
    expect(snapshot.tokenPass.percentUsed).toBeNull();
  });
});
