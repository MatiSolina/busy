import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defined } from "../test-utils";
import dynamic from "./manage_routines";

const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("../lib/hub", () => ({ hubFetch }));

const ROUTINE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface Tool {
  execute: (
    input: Record<string, unknown>,
    ctx: unknown
  ) => Promise<Record<string, unknown>>;
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
}

const dynamicResolver = (
  dynamic as unknown as Record<symbol, (ctx: unknown) => Tool | null>
)[defined(Object.getOwnPropertySymbols(dynamic)[0])];
const context = (
  principalId = "owner:team:project:busy:environment:production",
  callId = "call-1",
  principalType = "app"
) => ({
  abortSignal: new AbortController().signal,
  callId,
  session: {
    auth: { current: { principalId, principalType } },
    id: "session-1",
  },
});
const tool = () => defined(dynamicResolver(context()));

beforeEach(() => {
  hubFetch.mockReset().mockResolvedValue(Response.json({ routines: [] }));
});
afterEach(() => vi.restoreAllMocks());

describe("manage_routines input", () => {
  it.each([
    ["list", { action: "list" }, true],
    [
      "create",
      {
        action: "create",
        name: "Brief",
        prompt: "Review updates",
        time: "09:00",
        timeZone: "America/Argentina/Cordoba",
      },
      true,
    ],
    [
      "update",
      {
        action: "update",
        enabled: false,
        id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
      },
      true,
    ],
    [
      "delete",
      { action: "delete", id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a" },
      true,
    ],
    [
      "create without id",
      {
        action: "create",
        id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
        name: "Brief",
        prompt: "Review",
        time: "09:00",
        timeZone: "UTC",
      },
      false,
    ],
    [
      "bad time",
      {
        action: "create",
        name: "Brief",
        prompt: "Review",
        time: "9:00",
        timeZone: "UTC",
      },
      false,
    ],
    [
      "bad time zone",
      {
        action: "create",
        name: "Brief",
        prompt: "Review",
        time: "09:00",
        timeZone: "Mars/Phobos",
      },
      false,
    ],
    [
      "duplicate days",
      {
        action: "create",
        daysOfWeek: [1, 1],
        name: "Brief",
        prompt: "Review",
        time: "09:00",
        timeZone: "UTC",
      },
      false,
    ],
    [
      "empty update",
      { action: "update", id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a" },
      false,
    ],
    [
      "create missing prompt",
      { action: "create", name: "Brief", time: "09:00", timeZone: "UTC" },
      false,
    ],
    ["list with create fields", { action: "list", name: "Brief" }, false],
    [
      "delete with update fields",
      {
        action: "delete",
        enabled: false,
        id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
      },
      false,
    ],
  ] as const)("accepts %s: %s", (_, input, valid) => {
    expect(tool().inputSchema.safeParse(input).success).toBe(valid);
  });

  it("publishes one object schema at the tool root", () => {
    const schema = z.toJSONSchema(tool().inputSchema as never) as {
      type?: string;
      anyOf?: unknown[];
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.required).toEqual(["action"]);
  });
});

describe("manage_routines calls", () => {
  it("creates without accepting a model-supplied id and is idempotent for a retry", async () => {
    hubFetch.mockImplementation(async () =>
      Response.json({ routine: { id: "generated" } })
    );
    const first = await tool().execute(
      {
        action: "create",
        name: "Brief",
        prompt: "Review updates",
        time: "09:00",
        timeZone: "UTC",
      },
      context()
    );
    const second = await tool().execute(
      {
        action: "create",
        name: "Brief",
        prompt: "Review updates",
        time: "09:00",
        timeZone: "UTC",
      },
      context()
    );
    expect(first).toEqual({ routine: { id: "generated" } });
    expect(second).toEqual(first);
    expect(hubFetch).toHaveBeenCalledTimes(2);
    const bodies = hubFetch.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body))
    );
    expect(bodies[0]).toMatchObject({
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      name: "Brief",
      prompt: "Review updates",
      time: "09:00",
      timeZone: "UTC",
    });
    expect(bodies[0].id).toMatch(ROUTINE_ID_RE);
    expect(bodies[1].id).toBe(bodies[0].id);
  });

  it("uses the expected routes for list, update, and delete", async () => {
    await tool().execute({ action: "list" }, context());
    await tool().execute(
      {
        action: "update",
        enabled: false,
        id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
      },
      context()
    );
    await tool().execute(
      { action: "delete", id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a" },
      context()
    );
    expect(
      hubFetch.mock.calls.map(([path, init]) => [path, init?.method])
    ).toEqual([
      ["/api/bot/routines", undefined],
      ["/api/bot/routines/8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a", "PATCH"],
      ["/api/bot/routines/8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a", "DELETE"],
    ]);
  });

  it("is completely unavailable in consultations", () => {
    expect(
      dynamicResolver(
        context("owner:team:project:bot-lawyer:environment:production")
      )
    ).toBeNull();
  });

  it("is unavailable to a scheduled run and rejects a stale offered call", async () => {
    const routinePrincipal =
      "busy-hub:hub:routine:8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a";
    expect(
      dynamicResolver(context(routinePrincipal, "call-1", "service"))
    ).toBeNull();

    const offeredToHub = tool();
    await expect(
      offeredToHub.execute(
        {
          action: "create",
          name: "Brief",
          prompt: "Review",
          time: "09:00",
          timeZone: "UTC",
        },
        context(routinePrincipal, "call-1", "service")
      )
    ).rejects.toThrow("Scheduled routine executions cannot manage routines.");
    expect(hubFetch).not.toHaveBeenCalled();
    // The ordinary hub principal remains eligible to manage routines.
    expect(
      dynamicResolver(context("busy-hub:hub", "call-2", "service"))
    ).not.toBeNull();
  });

  it("is unavailable to a code-task completion and rejects a stale offered call", async () => {
    const completionPrincipal =
      "busy-hub:hub:code-task:8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a";
    expect(
      dynamicResolver(context(completionPrincipal, "call-1", "service"))
    ).toBeNull();

    const offeredToCompletion = tool();
    await expect(
      offeredToCompletion.execute(
        {
          action: "create",
          name: "Brief",
          prompt: "Review",
          time: "09:00",
          timeZone: "UTC",
        },
        context(completionPrincipal, "call-1", "service")
      )
    ).rejects.toThrow("Code task completions cannot manage routines.");
    expect(hubFetch).not.toHaveBeenCalled();
  });

  it("returns bounded hub errors", async () => {
    hubFetch.mockResolvedValueOnce(
      new Response("secret details", { status: 500 })
    );
    await expect(
      tool().execute({ action: "list" }, context())
    ).resolves.toEqual({ error: "Couldn't list routines (500)" });
  });
});
