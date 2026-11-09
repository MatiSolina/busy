import type { PGlite } from "@electric-sql/pglite";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type BotsDatabase, botsDatabase } from "./lib/bots/test-helpers";

let client: PGlite;
let database: BotsDatabase;

vi.mock("./lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/db")>()),
  db: () => database,
}));

const { botFromRequest } = await import("./lib/bot-auth");

const TEAM = "busy-team";
let jwks: JWTVerifyGetKey;
let privateKey: CryptoKey;

/** A token shaped like Vercel's (claims as in @vercel/oidc VercelOidcPayload). */
async function token(claims: Record<string, unknown>, slug = "ana") {
  return await new SignJWT({
    environment: "production",
    owner_id: "team_1",
    project_id: "prj_current",
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(`https://oidc.vercel.com/${TEAM}`)
    .setAudience(`https://vercel.com/${TEAM}`)
    .setSubject(`owner:${TEAM}:project:bot-${slug}:environment:production`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

const call = async (bearer: string) => {
  const result = await botFromRequest(
    new Request("https://hub.test/api/bot/memory", {
      headers: { authorization: `Bearer ${bearer}` },
    }),
    { jwks }
  );
  return result instanceof Response ? result.status : result;
};

beforeAll(async () => {
  ({ client, database } = await botsDatabase());
  const pair = await generateKeyPair("ES256");
  ({ privateKey } = pair);
  jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "k1" }],
  });
  vi.stubEnv("VERCEL_TEAM_SLUG", TEAM);
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("VERCEL_TEAM_SLUG", TEAM);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await client.exec("DELETE FROM bots");
  await client.query(
    "INSERT INTO bots (slug, name, description, vercel_project_id) VALUES ('ana', 'Ana', '', 'prj_current'), ('beto', 'Beto', '', 'prj_beto'), ('legacy', 'Legacy', '', NULL)"
  );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

describe("bot identity is the linked Vercel project (H-08)", () => {
  it("accepts the bot's own project with its current slug", async () => {
    expect(await call(await token({}))).toEqual({ slug: "ana" });
  });

  it("refuses an old project with the same slug and a different project_id", async () => {
    expect(await call(await token({ project_id: "prj_deleted_bot" }))).toBe(
      401
    );
  });

  it("refuses a token without the project_id claim", async () => {
    expect(await call(await token({ project_id: undefined }))).toBe(401);
  });

  it("refuses the right project presenting another slug", async () => {
    // prj_current is ana's; a subject naming beto doesn't make it beto.
    expect(await call(await token({}, "beto"))).toBe(401);
  });

  it("refuses a non-production token", async () => {
    expect(await call(await token({ environment: "preview" }))).toBe(401);
  });

  it("refuses an unlinked row unless the compatibility window is explicitly on", async () => {
    const legacy = await token({ project_id: "prj_legacy" }, "legacy");
    expect(await call(legacy)).toBe(401);
    vi.stubEnv("BOT_OIDC_ALLOW_UNLINKED", "1");
    expect(await call(legacy)).toEqual({ slug: "legacy" });
    // The window never opens a linked row to another project.
    expect(await call(await token({ project_id: "prj_old" }))).toBe(401);
  });
});
