import {
  createHmac,
  sign as cryptoSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { type AuthFn, routeAuth } from "eve/channels/auth";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import config from "../config.json" with { type: "json" };
import { isConsultation } from "../lib/caller";
import { defined } from "../test-utils";

// The channel's real auth array (eve's jwtEcdsa, vercelOidc and localDev), walked by eve's own
// routeAuth with real signed tokens. Only eveChannel is a stand-in, to hand back its config.
vi.mock("eve/channels/eve", () => ({
  eveChannel: (channelConfig: unknown) => channelConfig,
}));

const SLUG = config.slug;
const TEAM = "mati-solina";
const VERCEL_ISSUER_RE =
  /^(?<issuer>https:\/\/oidc\.vercel\.com(?:\/[\w-]+)?)\/\.well-known\/(?<document>openid-configuration|jwks)$/u;
const BEARER_RE = /^Bearer\b/u;
const OIDC_RE = /oidc/u;
const BOT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,20}$/u;
const UUID_RE = /UUID/u;
const now = () => Math.floor(Date.now() / 1000);

// --- tokens ---------------------------------------------------------------------------------

const b64 = (v: unknown) =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString(
    "base64url"
  );
type Signer = (input: Buffer) => Buffer;
function jwt(header: object, claims: object, sign: Signer): string {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${sign(Buffer.from(input)).toString("base64url")}`;
}
const ecdsa =
  (key: KeyObject, hash = "sha256"): Signer =>
  (input) =>
    cryptoSign(hash, input, { dsaEncoding: "ieee-p1363", key });
const rsa =
  (key: KeyObject): Signer =>
  (input) =>
    cryptoSign("sha256", input, key);
const hmac =
  (secret: string): Signer =>
  (input) =>
    createHmac("sha256", secret).update(input).digest();

const ec = (namedCurve: string) => generateKeyPairSync("ec", { namedCurve });
const hub = ec("P-256");
const stranger = ec("P-256");
const HUB_JWK = JSON.stringify(hub.publicKey.export({ format: "jwk" }));
const HUB_PEM = hub.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

/** What the hub signs (apps/hub/lib/hub-token.ts): iss busy-hub, sub hub, aud = the bot's slug, 5 minutes. */
const hubClaims = (over: Record<string, unknown> = {}) => ({
  aud: SLUG,
  exp: now() + 300,
  iat: now(),
  iss: "busy-hub",
  sub: "hub",
  ...over,
});
const hubToken = (
  over: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  sign: Signer = ecdsa(hub.privateKey)
) => jwt({ alg: "ES256", ...header }, hubClaims(over), sign);

// Vercel OIDC: one RS256 key served from the team issuer's JWKS (fetch is stubbed below).
const vercel = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "vercel-test-key";
const JWKS = {
  keys: [
    {
      ...vercel.publicKey.export({ format: "jwk" }),
      alg: "RS256",
      kid: KID,
      use: "sig",
    },
  ],
};
const oidcClaims = (
  team: string,
  project: string,
  environment = "production",
  over: Record<string, unknown> = {}
) => ({
  aud: `https://vercel.com/${team}`,
  environment,
  exp: now() + 3600,
  iat: now(),
  iss: `https://oidc.vercel.com/${team}`,
  nbf: now(),
  owner: team,
  owner_id: `team_${team}`,
  project,
  project_id: `prj_${project}`,
  sub: `owner:${team}:project:${project}:environment:${environment}`,
  ...over,
});
const oidcToken = (
  team: string,
  project: string,
  environment?: string,
  over?: Record<string, unknown>,
  sign: Signer = rsa(vercel.privateKey)
) =>
  jwt(
    { alg: "RS256", kid: KID, typ: "JWT" },
    oidcClaims(team, project, environment, over),
    sign
  );

const fetched: string[] = [];
const fetchStub = vi.fn(async (input: string | URL | Request) => {
  await Promise.resolve();
  const url = input instanceof Request ? input.url : String(input);
  fetched.push(url);
  // Team issuers (https://oidc.vercel.com/<team>) and the global one (https://oidc.vercel.com).
  const issuer = VERCEL_ISSUER_RE.exec(url);
  if (issuer?.groups?.document === "openid-configuration") {
    return Response.json({
      issuer: issuer.groups.issuer,
      jwks_uri: `${issuer.groups.issuer}/.well-known/jwks`,
    });
  }
  if (issuer?.groups?.document === "jwks") {
    return Response.json(JWKS);
  }
  throw new Error(`no network in tests: ${url}`);
});

// --- the channel ------------------------------------------------------------------------------

interface Principal {
  authenticator?: string;
  issuer?: string;
  principalId: string;
  principalType: string;
  subject?: string;
}
interface Env {
  eveDev?: boolean;
  hubKey?: string;
  team?: string;
}

/** channels/eve.ts reads its env when it loads, so each setup imports a fresh copy. */
async function channel(env: Env = {}): Promise<AuthFn<Request>[]> {
  const { hubKey, team, eveDev } = {
    eveDev: false,
    hubKey: HUB_JWK,
    team: TEAM,
    ...env,
  };
  vi.resetModules();
  vi.stubEnv("HUB_PUBLIC_KEY", hubKey);
  vi.stubEnv("VERCEL_TEAM_SLUG", team);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: The test deliberately exercises both env states.
  vi.stubEnv("EVE_DEV", eveDev ? "1" : undefined);
  const { default: definition } = await import("./eve");
  return (definition as unknown as { auth: AuthFn<Request>[] }).auth;
}

const BOT_URL = `https://bot-${SLUG}.vercel.app/eve/v1/session`;
const req = (
  authorization?: string,
  headers: Record<string, string> = {},
  url = BOT_URL
) =>
  new Request(url, {
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...headers,
    },
  });

async function who(request: Request, env?: Env): Promise<Principal | null> {
  const result = await routeAuth(request, await channel(env));
  return result instanceof Response ? null : (result as Principal);
}
const bearer = (token: string, env?: Env) => who(req(`Bearer ${token}`), env);

beforeEach(() => {
  // A production deployment of some other project: no current-project bypass, no dev server.
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_TARGET_ENV", undefined);
  vi.stubEnv("VERCEL_PROJECT_ID", undefined);
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// --- the hub ----------------------------------------------------------------------------------

describe("the hub's token", () => {
  it("lets the hub in as a service, never as a consultation", async () => {
    const principal = await bearer(hubToken());
    expect(principal).toMatchObject({
      issuer: "busy-hub",
      principalId: "busy-hub:hub",
      principalType: "service",
      subject: "hub",
    });
    expect(isConsultation({ current: principal })).toBe(false);
  });

  it.each<[string, unknown]>([
    ["another case", "Busy-Hub"],
    ["a trailing space", "busy-hub "],
    ["a leading space", " busy-hub"],
    ["a longer name", "busy-hub-preview"],
    ["empty", ""],
    ["Vercel's issuer", `https://oidc.vercel.com/${TEAM}`],
    ["no issuer at all", undefined],
  ])("rejects an issuer with %s", async (_, iss) => {
    expect(await bearer(hubToken({ iss }))).toBeNull();
  });

  it.each<[string, unknown]>([
    ["this bot's slug", SLUG],
    ["a list with only this bot", [SLUG]],
    ["a list that includes this bot", ["other", SLUG]],
  ])("accepts an audience of %s", async (_, aud) => {
    expect(await bearer(hubToken({ aud }))).not.toBeNull();
  });

  // A bot that receives a token meant for it must not be able to replay it on another bot.
  it.each<[string, unknown]>([
    ["another bot's slug", "lawyer"],
    ["the slug in upper case", SLUG.toUpperCase()],
    ["the slug with a suffix", `${SLUG}-2`],
    ["the slug cut short", SLUG.slice(0, -1)],
    ["the project name instead of the slug", `bot-${SLUG}`],
    ["an empty string", ""],
    ["an empty list", []],
    ["a list of other bots", ["lawyer", "accountant"]],
    ["a wildcard", "*"],
    ["no audience at all", undefined],
  ])("rejects an audience of %s", async (_, aud) => {
    expect(await bearer(hubToken({ aud }))).toBeNull();
  });

  it.each<[string, number]>([
    ["5 minutes left", 300],
    ["1 second left", 1],
    ["expired 10 s ago (clock skew)", -10],
  ])("accepts a token with %s", async (_, exp) => {
    expect(await bearer(hubToken({ exp: now() + exp }))).not.toBeNull();
  });

  it.each<[string, number]>([
    ["expired an hour ago", -3600],
    ["expired a minute ago", -60],
    ["expired just past the clock skew", -45],
  ])("rejects a token that %s", async (_, exp) => {
    expect(await bearer(hubToken({ exp: now() + exp }))).toBeNull();
  });

  it("rejects a token that isn't valid yet", async () => {
    expect(await bearer(hubToken({ nbf: now() + 120 }))).toBeNull();
    expect(await bearer(hubToken({ nbf: now() }))).not.toBeNull();
  });

  it.each<[string, unknown]>([
    ["missing", undefined],
    ["empty", ""],
    ["not a string", 7],
  ])("rejects a subject that is %s", async (_, sub) => {
    expect(await bearer(hubToken({ sub }))).toBeNull();
  });

  it("rejects a token signed with another key", async () => {
    expect(
      await bearer(hubToken({}, {}, ecdsa(stranger.privateKey)))
    ).toBeNull();
  });

  it("rejects a hub token whose audience was edited after signing", async () => {
    const [header, , signature] = hubToken({ aud: "lawyer" }).split(".");
    expect(
      await bearer(`${header}.${b64(hubClaims())}.${signature}`)
    ).toBeNull();
  });

  it("rejects a signature lifted from another token", async () => {
    const [, , signature] = hubToken({ aud: "lawyer" }).split(".");
    const [header, payload] = hubToken().split(".");
    expect(await bearer(`${header}.${payload}.${signature}`)).toBeNull();
  });

  it("rejects a truncated signature", async () => {
    expect(await bearer(hubToken().slice(0, -8))).toBeNull();
  });
});

describe("the hub's token: algorithm confusion", () => {
  it.each<[string, () => string]>([
    [
      "alg none, unsigned",
      () => `${b64({ alg: "none" })}.${b64(hubClaims())}.`,
    ],
    [
      "alg none, with the hub's signature",
      () =>
        `${b64({ alg: "none" })}.${hubToken().split(".").slice(1).join(".")}`,
    ],
    [
      "HS256 keyed with HUB_PUBLIC_KEY",
      () => jwt({ alg: "HS256" }, hubClaims(), hmac(HUB_JWK)),
    ],
    [
      "HS256 keyed with the PEM public key",
      () => jwt({ alg: "HS256" }, hubClaims(), hmac(HUB_PEM)),
    ],
    [
      "ES384 with the hub's own key",
      () => jwt({ alg: "ES384" }, hubClaims(), ecdsa(hub.privateKey, "sha384")),
    ],
    [
      "ES512 with a P-521 key",
      () =>
        jwt(
          { alg: "ES512" },
          hubClaims(),
          ecdsa(ec("P-521").privateKey, "sha512")
        ),
    ],
    [
      "RS256 with Vercel's key",
      () => jwt({ alg: "RS256" }, hubClaims(), rsa(vercel.privateKey)),
    ],
    [
      "a lower-case alg",
      () => jwt({ alg: "es256" }, hubClaims(), ecdsa(hub.privateKey)),
    ],
    [
      "ES256 with the attacker's key embedded in the header",
      () =>
        jwt(
          { alg: "ES256", jwk: stranger.publicKey.export({ format: "jwk" }) },
          hubClaims(),
          ecdsa(stranger.privateKey)
        ),
    ],
    [
      "a DER signature instead of r||s",
      () =>
        jwt({ alg: "ES256" }, hubClaims(), (input) =>
          cryptoSign("sha256", input, hub.privateKey)
        ),
    ],
  ])("rejects %s", async (_, token) => {
    expect(await bearer(token())).toBeNull();
  });

  it("never fetches a key from a URL the token names", async () => {
    const token = jwt(
      { alg: "ES256", jku: "https://attacker.example/jwks.json", kid: "x" },
      hubClaims(),
      ecdsa(stranger.privateKey)
    );
    expect(await bearer(token)).toBeNull();
    expect(fetched.filter((u) => u.includes("attacker"))).toEqual([]);
  });
});

describe("the hub's token: how it arrives", () => {
  it.each<[string, () => Request]>([
    ["no credentials", () => req()],
    [
      "a Basic credential",
      () => req(`Basic ${Buffer.from(`hub:${hubToken()}`).toString("base64")}`),
    ],
    ["Bearer with nothing after it", () => req("Bearer ")],
    ["the token without a scheme", () => req(hubToken())],
    [
      "the token in the query string",
      () => req(undefined, {}, `${BOT_URL}?token=${hubToken()}`),
    ],
    [
      "the token in a cookie",
      () => req(undefined, { cookie: `token=${hubToken()}` }),
    ],
    ["the token twice", () => req(`Bearer ${hubToken()} ${hubToken()}`)],
  ])("rejects %s", async (_, request) => {
    expect(await who(request())).toBeNull();
  });

  // Whatever arrives, the walk ends in a 401, never an exception (a 500 from the route).
  it.each<[string, () => string]>([
    ["two segments", () => "a.b"],
    ["four segments", () => `${hubToken()}.extra`],
    ["only dots", () => "..."],
    ["characters outside base64url", () => "no base64!.###.$$$"],
    [
      "a header that isn't JSON",
      () => `${b64("hi")}.${b64(hubClaims())}.${b64("sig")}`,
    ],
    [
      "a payload that is a JSON array",
      () => `${b64({ alg: "ES256" })}.${b64("[1,2]")}.${b64("sig")}`,
    ],
    [
      "a payload that is null",
      () => `${b64({ alg: "RS256", kid: KID })}.${b64("null")}.${b64("sig")}`,
    ],
    [
      "a 64 KiB token",
      () => `${b64({ alg: "ES256" })}.${"A".repeat(65_536)}.${b64("sig")}`,
    ],
  ])("answers garbage with %s with a 401", async (_, token) => {
    const res = await routeAuth(req(`Bearer ${token()}`), await channel());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it("answers a rejected token with 401, a Bearer challenge and no caching", async () => {
    const res = await routeAuth(
      req(`Bearer ${hubToken({ aud: "lawyer" })}`),
      await channel()
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect((res as Response).headers.get("www-authenticate")).toMatch(
      BEARER_RE
    );
    expect((res as Response).headers.get("cache-control")).toBe("no-store");
  });
});

describe("HUB_PUBLIC_KEY", () => {
  it.each<[string, string | undefined]>([
    ["unset", undefined],
    ["empty", ""],
  ])("keeps the hub out when %s", async (_, hubKey) => {
    expect(await bearer(hubToken(), { hubKey })).toBeNull();
  });

  it.each<[string, string]>([
    ["a JWK, as the hub sets it", HUB_JWK],
    ["a PEM public key", HUB_PEM],
    ["a JWK with a trailing newline", `${HUB_JWK}\n`],
  ])("accepts the key as %s", async (_, hubKey) => {
    expect(await bearer(hubToken(), { hubKey })).toMatchObject({
      principalId: "busy-hub:hub",
    });
  });

  it("fails closed with a key that doesn't parse", async () => {
    const token = hubToken();
    expect(await bearer(token, { hubKey: "{not json" })).toBeNull();
    expect(
      await bearer(token, {
        hubKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
      })
    ).toBeNull();
  });

  it("rejects tokens of a rotated-out key", async () => {
    const rotated = JSON.stringify(
      stranger.publicKey.export({ format: "jwk" })
    );
    expect(await bearer(hubToken(), { hubKey: rotated })).toBeNull();
  });

  it("still lets other bots consult without it", async () => {
    expect(
      await bearer(oidcToken(TEAM, "bot-lawyer"), { hubKey: undefined })
    ).not.toBeNull();
  });
});

// --- other bots -------------------------------------------------------------------------------

describe("other bots (Vercel OIDC)", () => {
  it.each(["bot-lawyer", "bot-a", "bot-2024-reports", "bot-bot"])(
    "lets %s in production consult, as a consultation",
    async (project) => {
      const principal = await bearer(oidcToken(TEAM, project));
      expect(principal).toMatchObject({
        subject: `owner:${TEAM}:project:${project}:environment:production`,
      });
      expect(isConsultation({ current: principal })).toBe(true);
    }
  );

  it.each(["preview", "development"])(
    "rejects a bot's %s deployment",
    async (environment) => {
      expect(
        await bearer(oidcToken(TEAM, "bot-lawyer", environment))
      ).toBeNull();
    }
  );

  // The hub's own Vercel token used to be valid on every bot; now only its signed token is.
  it.each([
    ["the hub's own project", "busy-hub"],
    ["a project named just bot", "bot"],
    ["a project that ends in bot-", "robot-x"],
    ["a project that starts with bots-", "bots-x"],
    ["a project with bot- in the middle", "x-bot-y"],
  ])("rejects %s", async (_, project) => {
    expect(await bearer(oidcToken(TEAM, project))).toBeNull();
  });

  it.each([
    ["another team", "acme"],
    ["a team whose slug starts with ours", `${TEAM}-evil`],
  ])("rejects a bot of %s", async (_, team) => {
    expect(await bearer(oidcToken(team, "bot-lawyer"))).toBeNull();
  });

  it("lets in a bot whose team uses Vercel's global issuer", async () => {
    const token = jwt(
      { alg: "RS256", kid: KID, typ: "JWT" },
      oidcClaims(TEAM, "bot-lawyer", "production", {
        iss: "https://oidc.vercel.com",
      }),
      rsa(vercel.privateKey)
    );
    const principal = await bearer(token);
    expect(principal).toMatchObject({
      subject: `owner:${TEAM}:project:bot-lawyer:environment:production`,
    });
    expect(isConsultation({ current: principal })).toBe(true);
  });

  it("rejects a token Vercel didn't sign", async () => {
    const forged = rsa(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    );
    expect(
      await bearer(oidcToken(TEAM, "bot-lawyer", "production", {}, forged))
    ).toBeNull();
  });

  it("rejects an expired bot token", async () => {
    expect(
      await bearer(
        oidcToken(TEAM, "bot-lawyer", "production", {
          exp: now() - 3600,
          iat: now() - 7200,
          nbf: now() - 7200,
        })
      )
    ).toBeNull();
  });

  it("rejects a bot token minted for something other than Vercel", async () => {
    expect(
      await bearer(
        oidcToken(TEAM, "bot-lawyer", "production", {
          aud: "https://example.com",
        })
      )
    ).toBeNull();
  });

  it.each<[string, string | undefined]>([
    ["unset", undefined],
    ["empty", ""],
  ])("lets no bot in when VERCEL_TEAM_SLUG is %s", async (_, team) => {
    expect(await bearer(oidcToken(TEAM, "bot-lawyer"), { team })).toBeNull();
  });

  it("still lets the hub in when VERCEL_TEAM_SLUG is missing", async () => {
    expect(await bearer(hubToken(), { team: undefined })).toMatchObject({
      principalId: "busy-hub:hub",
    });
  });

  it("never takes a hub-signed token as a bot", async () => {
    const asBot = await bearer(
      hubToken({
        sub: `owner:${TEAM}:project:bot-lawyer:environment:production`,
      })
    );
    expect(asBot).toMatchObject({ issuer: "busy-hub" });
    expect(asBot?.authenticator).not.toMatch(OIDC_RE);
  });
});

describe("who counts as a consultation", () => {
  const slug = fc.stringMatching(BOT_SLUG_RE);

  it("every production bot of the team is a consultation", async () => {
    const auth = await channel();
    await fc.assert(
      fc.asyncProperty(slug, async (s) => {
        const principal = await routeAuth(
          req(`Bearer ${oidcToken(TEAM, `bot-${s}`)}`),
          auth
        );
        expect(principal).not.toBeInstanceOf(Response);
        expect(isConsultation({ current: principal as Principal })).toBe(true);
      }),
      { numRuns: 25, seed: 1 }
    );
  });

  it("a hub token opens only the bot it names, never another (no replay between bots)", async () => {
    await fc.assert(
      fc.asyncProperty(slug, slug, async (addressed, receiving) => {
        fc.pre(addressed !== receiving);
        vi.resetModules();
        vi.doMock("../config.json", () => ({
          default: { ...config, slug: receiving },
        }));
        const auth = await channel();
        vi.doUnmock("../config.json");
        expect(
          await routeAuth(req(`Bearer ${hubToken({ aud: addressed })}`), auth)
        ).toBeInstanceOf(Response);
        expect(
          await routeAuth(req(`Bearer ${hubToken({ aud: receiving })}`), auth)
        ).not.toBeInstanceOf(Response);
      }),
      { numRuns: 15, seed: 1 }
    );
  });

  it("the hub is never one, whatever bot it addresses", async () => {
    await fc.assert(
      fc.asyncProperty(slug, async (s) => {
        vi.resetModules();
        vi.doMock("../config.json", () => ({
          default: { ...config, slug: s },
        }));
        const auth = await channel();
        const principal = await routeAuth(
          req(`Bearer ${hubToken({ aud: s })}`),
          auth
        );
        vi.doUnmock("../config.json");
        expect(principal).not.toBeInstanceOf(Response);
        expect(isConsultation({ current: principal as Principal })).toBe(false);
      }),
      { numRuns: 15, seed: 1 }
    );
  });
});

// --- local development -------------------------------------------------------------------------

describe("local development", () => {
  it("lets nothing in without credentials in production", async () => {
    expect(
      await who(req(undefined, {}, "http://localhost:3000/eve/v1/session"))
    ).toBeNull();
  });

  it("lets a local caller in under eve dev, not as a consultation", async () => {
    const principal = await who(
      req(undefined, {}, "http://localhost:3000/eve/v1/session"),
      { eveDev: true }
    );
    expect(principal).toMatchObject({ principalType: "local-dev" });
    expect(isConsultation({ current: principal })).toBe(false);
  });

  it("refuses a page on another site reaching the dev server through the browser", async () => {
    const request = req(
      undefined,
      { origin: "https://evil.example" },
      "http://localhost:3000/eve/v1/session"
    );
    expect(await who(request, { eveDev: true })).toBeNull();
  });

  it("still identifies the hub under eve dev", async () => {
    const request = req(
      `Bearer ${hubToken()}`,
      {},
      "http://localhost:3000/eve/v1/session"
    );
    expect(await who(request, { eveDev: true })).toMatchObject({
      principalId: "busy-hub:hub",
    });
  });
});

// --- what the hub deploys ---------------------------------------------------------------------

// The hub's own signer (apps/hub/lib/hub-token.ts) and deploy step (apps/hub/lib/bots/deploy.ts):
// the env vars and config.json it gives a bot project must open that bot to the hub, and only it.
interface HubToken {
  hubPublicKey: (raw: string) => string;
  signConsultationToken: (
    from: { id: string; slug: string },
    to: { id: string; slug: string },
    raw: string
  ) => Promise<{ token: string }>;
  signHubToken: (slug: string, raw: string) => Promise<string>;
  signRoutineToken: (
    slug: string,
    runId: string,
    raw: string
  ) => Promise<string>;
}
interface Deploy {
  startDeploy: (
    bot: object,
    settings: object,
    deps: object
  ) => Promise<unknown>;
}
const hubLib = (path: string) =>
  new URL(`../../../../apps/hub/lib/${path}`, import.meta.url).href;
const { signConsultationToken, signHubToken, signRoutineToken, hubPublicKey } =
  (await import(hubLib("hub-token.ts"))) as HubToken;
const { startDeploy } = (await import(hubLib("bots/deploy.ts"))) as Deploy;
const SIGNING_KEY = JSON.stringify(
  ec("P-256").privateKey.export({ format: "jwk" })
);

async function deployed(slug: string): Promise<AuthFn<Request>[]> {
  const env: Record<string, string> = {};
  let files: { file: string; data: string }[] = [];
  await startDeploy(
    {
      billing: "gateway",
      description: "Contracts.",
      id: "b1",
      instructions: "",
      model: "moonshotai/kimi-k3",
      name: "Lawyer",
      slug,
    },
    {
      botsDomain: "bots.example.com",
      hubPublicKey: hubPublicKey(SIGNING_KEY),
      hubUrl: "https://hub.example.com",
      teamSlug: TEAM,
    },
    {
      addProjectDomain: async () => {
        await Promise.resolve();
        // Deliberate no-op: the deployment fixture only needs the call recorded by the mock.
      },
      createDeployment: async (_: string, f: typeof files) => {
        await Promise.resolve();
        files = f;
        return { id: "dpl_1", url: "bot.example.com" };
      },
      createSession: async () => "s1",
      ensureProject: async () => ({ existed: false }),
      getDeploymentState: async () => ({ readyState: "READY" }),
      removeProjectEnv: async () => {
        // Deliberate no-op: the deployment fixture does not persist env removal.
      },
      upsertProjectEnv: async (_: string, vars: Record<string, string>) => {
        await Promise.resolve();
        Object.assign(env, vars);
      },
    }
  );
  const deployedConfig = JSON.parse(
    defined(files.find((f) => f.file === "agent/config.json")).data
  ) as typeof config;
  vi.resetModules();
  vi.doMock("../config.json", () => ({ default: deployedConfig }));
  vi.stubEnv("HUB_PUBLIC_KEY", undefined);
  vi.stubEnv("VERCEL_TEAM_SLUG", undefined);
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const { default: definition } = await import("./eve");
  vi.doUnmock("../config.json");
  return (definition as unknown as { auth: AuthFn<Request>[] }).auth;
}
const through = async (auth: AuthFn<Request>[], token: string) => {
  const result = await routeAuth(req(`Bearer ${token}`), auth);
  return result instanceof Response ? null : (result as Principal);
};

describe("what the hub deploys", () => {
  it("opens the bot to a token from the hub's own signer, not as a consultation", async () => {
    const principal = await through(
      await deployed("lawyer"),
      await signHubToken("lawyer", SIGNING_KEY)
    );
    expect(principal).toMatchObject({ principalId: "busy-hub:hub" });
    expect(isConsultation({ current: principal })).toBe(false);
  });

  it("opens a routine as a distinct stable service principal for that occurrence", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const auth = await deployed("lawyer");
    const first = await through(
      auth,
      await signRoutineToken("lawyer", runId, SIGNING_KEY)
    );
    const second = await through(
      auth,
      await signRoutineToken("lawyer", runId, SIGNING_KEY)
    );
    const other = await through(
      auth,
      await signRoutineToken(
        "lawyer",
        "22222222-2222-4222-8222-222222222222",
        SIGNING_KEY
      )
    );

    expect(first).toMatchObject({
      issuer: "busy-hub",
      principalId: `busy-hub:hub:routine:${runId}`,
      principalType: "service",
      subject: `hub:routine:${runId}`,
    });
    expect(second?.principalId).toBe(first?.principalId);
    expect(other?.principalId).toBe(
      "busy-hub:hub:routine:22222222-2222-4222-8222-222222222222"
    );
    expect(isConsultation({ current: first })).toBe(false);
  });

  it("rejects a routine token whose occurrence id is not a UUID", async () => {
    await expect(
      signRoutineToken("lawyer", "not-a-run", SIGNING_KEY)
    ).rejects.toThrow(UUID_RE);
  });

  it("keeps it closed to the hub's token for another bot", async () => {
    expect(
      await through(
        await deployed("lawyer"),
        await signHubToken("accountant", SIGNING_KEY)
      )
    ).toBeNull();
  });

  it("lets the team's other bots consult it", async () => {
    const principal = await through(
      await deployed("lawyer"),
      oidcToken(TEAM, "bot-accountant")
    );
    expect(isConsultation({ current: principal })).toBe(true);
  });

  it.each<[string, number, boolean]>([
    ["4 minutes ago", 4, true],
    ["6 minutes ago", 6, false],
  ])("takes a hub token signed %s: %s", async (_, minutes, accepted) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - minutes * 60_000);
    const token = await signHubToken("lawyer", SIGNING_KEY);
    vi.useRealTimers();
    expect((await through(await deployed("lawyer"), token)) !== null).toBe(
      accepted
    );
  });
});

// H-26: the hub's real consultation signer against the deployed channels of two bots.
describe("consultation credentials from the hub's signer", () => {
  const ASKER = { id: "11111111-1111-4111-8111-111111111111", slug: "sales" };
  const LAWYER = { id: "22222222-2222-4222-8222-222222222222", slug: "lawyer" };
  const ACCOUNTANT = {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "accountant",
  };
  const credential = async (to = LAWYER) =>
    (await signConsultationToken(ASKER, to, SIGNING_KEY)).token;

  it("lets the named bot admit it as a read-only consultation", async () => {
    const principal = await through(
      await deployed("lawyer"),
      await credential()
    );
    expect(principal).toMatchObject({
      principalId: `busy-hub:consultation:${ASKER.id}:${LAWYER.id}`,
      principalType: "service",
    });
    expect(isConsultation({ current: principal })).toBe(true);
  });

  it("is refused by any other bot, so the consulted bot can't forward it", async () => {
    expect(
      await through(await deployed("accountant"), await credential())
    ).toBeNull();
    expect(
      await through(await deployed("lawyer"), await credential(ACCOUNTANT))
    ).toBeNull();
  });

  it("refuses a credential signed six minutes ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 6 * 60_000);
    const token = await credential();
    vi.useRealTimers();
    expect(await through(await deployed("lawyer"), token)).toBeNull();
  });

  it("keeps the legacy peer OIDC until BUSY_LEGACY_PEER_OIDC=off retires it", async () => {
    const peer = oidcToken(TEAM, "bot-accountant");
    expect(await through(await deployed("lawyer"), peer)).not.toBeNull();
    vi.stubEnv("BUSY_LEGACY_PEER_OIDC", "off");
    expect(await through(await deployed("lawyer"), peer)).toBeNull();
    // The hub-signed credential keeps working once the wildcard is gone.
    expect(
      await through(await deployed("lawyer"), await credential())
    ).not.toBeNull();
    vi.stubEnv("BUSY_LEGACY_PEER_OIDC", undefined);
  });
});
