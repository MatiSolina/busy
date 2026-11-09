import { describe, expect, it } from "vitest";
import { decryptOAuth, encryptOAuth } from "./crypto";

describe("sealed MCP OAuth payloads", () => {
  const payload = {
    clientInformation: { client_id: "client-1" },
    tokens: {
      access_token: "access",
      expires_in: 3600,
      refresh_token: "refresh",
      token_type: "bearer",
    },
  };

  it("round-trips and produces a fresh ciphertext each time", () => {
    const first = encryptOAuth(
      payload,
      "connection-1",
      "a sufficiently long test secret"
    );
    const second = encryptOAuth(
      payload,
      "connection-1",
      "a sufficiently long test secret"
    );
    expect(first).not.toBe(second);
    expect(
      decryptOAuth<typeof payload>(
        first,
        "connection-1",
        "a sufficiently long test secret"
      )
    ).toEqual(payload);
  });

  it.each([
    ["another connection", "connection-2", "a sufficiently long test secret"],
    ["another secret", "connection-1", "a different long test secret"],
  ])("rejects %s", (_, connectionId, secret) => {
    const sealed = encryptOAuth(
      payload,
      "connection-1",
      "a sufficiently long test secret"
    );
    expect(() => decryptOAuth(sealed, connectionId, secret)).toThrow(
      "Invalid sealed MCP OAuth payload"
    );
  });

  it("does not expose plaintext when the payload is malformed", () => {
    expect(() =>
      decryptOAuth(
        "v1.invalid",
        "connection-1",
        "a sufficiently long test secret"
      )
    ).toThrow("Invalid sealed MCP OAuth payload");
  });
});
