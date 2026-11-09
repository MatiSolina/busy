import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isConsultation } from "./caller";

type Auth = Parameters<typeof isConsultation>[0];

const as = (principalId: string, principalType = "app"): Auth => ({
  current: { principalId, principalType },
});
const oidc = (team: string, project: string, env = "production") =>
  `owner:${team}:project:${project}:environment:${env}`;
const BOT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,24}$/u;

describe("isConsultation: another bot calling", () => {
  it.each([
    ["a bot of the same team", oidc("mati-solina", "bot-lawyer")],
    ["a bot of another team", oidc("acme", "bot-ventas")],
    ["a bot with a one-letter slug", oidc("mati-solina", "bot-a")],
    ["a bot with digits in its slug", oidc("mati-solina", "bot-2024-reports")],
    ["a bot whose slug repeats the prefix", oidc("mati-solina", "bot-bot")],
    ["a bot whose team is also named bot-", oidc("bot-team", "bot-x")],
  ])("is true for %s", (_, id) => {
    expect(isConsultation(as(id))).toBe(true);
  });

  // The channel only admits production bots; anything else that still looks like a bot stays on
  // the read-only, one-hop side.
  it.each(["preview", "development", "staging"])(
    "fails closed for a bot from the %s environment",
    (env) => {
      expect(isConsultation(as(oidc("mati-solina", "bot-lawyer", env)))).toBe(
        true
      );
    }
  );

  it.each([["user"], ["service"], ["runtime"], [undefined]])(
    "decides by subject alone (principalType %s)",
    (type) => {
      expect(
        isConsultation({
          current: { principalId: oidc("t", "bot-a"), principalType: type },
        })
      ).toBe(true);
    }
  );
});

describe("isConsultation: the hub, people and the runtime", () => {
  it.each([
    ["the hub's signed token", "hub"],
    ["the hub's own Vercel project", oidc("mati-solina", "busy-hub")],
    ["eve's app identity (schedules)", "eve:app"],
    ["the local dev server", "local-dev"],
    ["an anonymous caller", "anonymous"],
    ["a person by email", "mati@example.com"],
    ["a person by uuid", "6f1c1a2e-4b0e-4b8f-9b8a-2f7d1f0b9c11"],
    ["an empty subject", ""],
  ])("is false for %s", (_, id) => {
    expect(isConsultation(as(id))).toBe(false);
  });

  it.each([
    ["robot-a", "contains bot- inside a word"],
    ["chatbot-ventas", "ends a word with bot-"],
    ["busy-bot-x", "has bot- after another prefix"],
    ["bots-hub", "starts with bots-"],
    ["bot", "is exactly bot without a dash"],
    ["botx", "starts with bot but no dash"],
    ["Bot-lawyer", "is capitalized"],
    ["BOT-LAWYER", "is upper case"],
  ])("is false for project %s, which %s", (project) => {
    expect(isConsultation(as(oidc("mati-solina", project)))).toBe(false);
  });

  it.each([
    ["a team named bot-", oidc("bot-team", "busy-hub")],
    [
      "bot- only in the environment",
      oidc("mati-solina", "busy-hub", "bot-preview"),
    ],
    ["a bare slug without the project segment", "bot-lawyer"],
    [
      "a subject missing the separator before project",
      "project:bot-lawyer:environment:production",
    ],
    [
      "a project segment with a space",
      "owner:t:project: bot-a:environment:production",
    ],
  ])("is false for %s", (_, id) => {
    expect(isConsultation(as(id))).toBe(false);
  });
});

describe("isConsultation: the hub-signed consultation credential (H-26)", () => {
  const signed = (fromBotId: string, type = "service") =>
    as(`busy-hub:consultation:${fromBotId}`, type);

  it("recognizes the principal eve's jwtEcdsa builds from it, without a project segment", () => {
    expect(isConsultation(signed("11111111-1111-4111-8111-111111111111"))).toBe(
      true
    );
  });

  it.each(["service", "app", "user", "runtime"])(
    "fails closed whatever the principal type (%s)",
    (type) => {
      expect(isConsultation(signed("x", type))).toBe(true);
    }
  );

  it.each([
    ["the hub", "busy-hub:hub"],
    ["a routine", "busy-hub:hub:routine:11111111-1111-4111-8111-111111111111"],
    [
      "a code-task notice",
      "busy-hub:hub:code-task:11111111-1111-4111-8111-111111111111",
    ],
    ["a look-alike after another prefix", "x:busy-hub:consultation:a"],
    ["a different issuer", "other:consultation:a"],
  ])("does not mistake %s for one", (_, id) => {
    expect(isConsultation(as(id, "service"))).toBe(false);
  });
});

describe("isConsultation: missing or partial auth", () => {
  it.each<[string, Auth]>([
    ["undefined auth", undefined],
    ["null auth", null],
    ["auth without current", {}],
    ["current undefined", { current: undefined }],
    ["current null (unprotected agent)", { current: null }],
    ["current without fields", { current: {} }],
    ["current without principalId", { current: { principalType: "app" } }],
  ])("is false with %s", (_, auth) => {
    expect(isConsultation(auth)).toBe(false);
  });

  it("looks only at the current caller, not at who started the session", () => {
    const bot = { principalId: oidc("t", "bot-a"), principalType: "app" };
    const hub = { principalId: "hub", principalType: "app" };
    const startedByBot = { current: hub, initiator: bot };
    const startedByHub = { current: bot, initiator: hub };
    expect(isConsultation(startedByBot)).toBe(false);
    expect(isConsultation(startedByHub)).toBe(true);
  });

  it("does not mutate a frozen auth object", () => {
    const auth = Object.freeze({
      current: Object.freeze({
        principalId: oidc("t", "bot-a"),
        principalType: "app",
      }),
    });
    expect(isConsultation(auth)).toBe(true);
    expect(auth.current.principalId).toBe(oidc("t", "bot-a"));
  });
});

describe("isConsultation: properties", () => {
  const slug = fc.stringMatching(BOT_SLUG_RE);
  const env = fc.constantFrom("production", "preview", "development");

  it("is true iff the OIDC subject names a bot-* project", () => {
    const project = fc.oneof(
      slug.map((s) => `bot-${s}`),
      slug
    );
    fc.assert(
      fc.property(slug, project, env, (team, name, environment) => {
        expect(isConsultation(as(oidc(team, name, environment)))).toBe(
          name.startsWith("bot-")
        );
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("is false for any principal without a project segment", () => {
    const id = fc.oneof(
      fc.emailAddress(),
      fc.uuid(),
      fc.string({ maxLength: 40 }).filter((s) => !s.includes(":project:"))
    );
    fc.assert(
      fc.property(id, (principalId) => {
        expect(isConsultation(as(principalId))).toBe(false);
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("ignores the principal type", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), slug, (type, s) => {
        expect(isConsultation(as(oidc("t", `bot-${s}`), type))).toBe(true);
        expect(isConsultation(as(oidc("t", `hub-${s}`), type))).toBe(false);
      }),
      { numRuns: 200, seed: 1 }
    );
  });
});
