import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isSensitiveArtifactName,
  isTextArtifact,
  MAX_SCANNABLE_TEXT_BYTES,
  scanTextArtifact,
} from "./artifact-safety";

const PRIVATE_KEY_MARKER = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

describe("bot artifact safety", () => {
  it.each([
    "API_KEY=fixture-secret-value",
    '{"password":"allletterpassword"}',
    "password: allletterpassword",
    "- password: fixture-secret7-value",
    "Credentials: password=fixture-secret7-value",
    "The password=fixture-secret7-value",
  ])(
    "blocks explicit credential assignments without requiring digits",
    (text) => {
      expect(
        scanTextArtifact(
          "report.txt",
          "text/plain",
          new TextEncoder().encode(text)
        )
      ).toBe("credential_pattern");
    }
  );

  it.each([
    ".env",
    ".env.production",
    "credentials.json",
    "credentials.txt",
    "secret.txt",
    "token.txt",
    "service-account.json",
    "service-account.txt",
    "id_rsa",
  ])("blocks sensitive filename %s", (name) => {
    expect(isSensitiveArtifactName(name)).toBe(true);
  });

  it.each([
    ".env.example",
    ".env.sample",
    "certificate.pem",
    "report.pdf",
    "financial-summary.xlsx",
    "secrets-of-the-ocean.pdf",
  ])("keeps an ordinary deliverable filename %s", (name) => {
    expect(isSensitiveArtifactName(name)).toBe(false);
  });

  it("recognizes textual content types without treating PDFs as text", () => {
    expect(isTextArtifact("text/plain", "report.bin")).toBe(true);
    expect(isTextArtifact("application/json", "report.bin")).toBe(true);
    expect(isTextArtifact("application/pdf", "report.pdf")).toBe(false);
  });

  it.each([
    "API_KEY=fixture-secret7-value",
    '{"password":"fixture-password7-value"}',
    "password: 'fixturePassword7!'",
    "Usuario qa@example.test contraseña fixture-password7-value",
    "Authorization: Bearer fixture-token7-value",
    "Authorization: Bearer  fixture-token7-value",
    "password=`fixturePassword7!`",
    'API_KEY="\nfixture-secret-value\n"',
    'password="\n"API_KEY"="fixture-secret-value"',
    'password="<\nAPI_KEY=fixture-secret-value\n>"',
    'password="<API_KEY=fixture-secret-value>"',
    "API_KEY=\nfixture-secret-value",
    '{"password"\n:\n"fixture-secret-value"}',
    'password=\nAPI_KEY\n:\n"fixture-secret-value"',
    'password\n=api key="fixture-secret-value"',
    'password\n:access token="fixture-secret-value"',
    "password=api key: fixture-secret7-value",
    "password=abcsecret=xy",
    "password=abc-secret=xy",
    "password=fixture-secret-value API_KEY=[REDACTED]",
    "password=fixture-secret-value api key: <your-api-key>",
    'password=\n"API_KEY"="fixture-secret-value"',
    'password="fixturePassword7!" extra prose',
    'password="fixturePassword7\\""',
    PRIVATE_KEY_MARKER,
    "github_pat_fixture_12345678901234567890",
  ])("blocks a credential-shaped text fixture", (text) => {
    expect(
      scanTextArtifact(
        "report.txt",
        "text/plain",
        new TextEncoder().encode(text)
      )
    ).toBe("credential_pattern");
  });

  it("recovers after an unterminated quoted field and still scans later lines", () => {
    expect(
      scanTextArtifact(
        "report.txt",
        "text/plain",
        new TextEncoder().encode('password="\nAPI_KEY=fixture-secret7-value')
      )
    ).toBe("credential_pattern");
    expect(
      scanTextArtifact(
        "report.txt",
        "text/plain",
        new TextEncoder().encode(
          'password="[REDACTED]\nAPI_KEY=fixture-secret7-value'
        )
      )
    ).toBe("credential_pattern");
  });

  it("does not let a multiline empty assignment swallow the next quoted key", () => {
    expect(
      scanTextArtifact(
        "report.txt",
        "text/plain",
        new TextEncoder().encode('password=\nAPI_KEY="fixture-secret7-value"')
      )
    ).toBe("credential_pattern");
  });

  it("does not block ordinary prose that mentions credentials", () => {
    for (const text of [
      "The login requires password rotation policy.",
      "The user password rotation policy applies.",
      "Login uses password management guidelines.",
      "The report discusses contraseña rotation policy.",
      "Credentials: `API_KEY=<your-api-key>`",
    ]) {
      expect(
        scanTextArtifact(
          "report.txt",
          "text/plain",
          new TextEncoder().encode(text)
        )
      ).toBeNull();
    }
  });

  it.each([
    "API_KEY=<your-api-key>",
    "password=[REDACTED]",
    "The policy says password: rotation policy.",
  ])("does not treat sanitized or policy text as a credential: %s", (text) => {
    expect(
      scanTextArtifact(
        "report.txt",
        "text/plain",
        new TextEncoder().encode(text)
      )
    ).toBeNull();
  });

  it("blocks invalid UTF-8 in a declared text artifact instead of allowing it through", () => {
    expect(
      scanTextArtifact("report.txt", "text/plain", new Uint8Array([0xff]))
    ).toBe("unscannable_text");
  });

  it("marks oversized textual artifacts as unscannable", () => {
    expect(
      scanTextArtifact(
        "report.txt",
        "text/plain",
        new Uint8Array(MAX_SCANNABLE_TEXT_BYTES + 1)
      )
    ).toBe("unscannable_text");
  });

  it("sniffs plaintext even when renamed as a binary deliverable", () => {
    expect(
      scanTextArtifact(
        "report.pdf",
        "application/pdf",
        new TextEncoder().encode("password=fixture-secret7-value")
      )
    ).toBe("credential_pattern");
    expect(
      scanTextArtifact(
        "secrets.bin",
        "application/octet-stream",
        new TextEncoder().encode('{"password":"fixture-password7-value"}')
      )
    ).toBe("credential_pattern");
  });

  it("keeps ordinary binary bytes without credential-shaped content", () => {
    expect(
      scanTextArtifact(
        "report.pdf",
        "application/pdf",
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02])
      )
    ).toBeNull();
  });

  it("does not let an appended NUL bypass a renamed plaintext artifact", () => {
    expect(
      scanTextArtifact(
        "report.bin",
        "application/octet-stream",
        new TextEncoder().encode("API_KEY=fixture-secret7-value\u0000")
      )
    ).toBe("credential_pattern");
  });

  it("inspects PEM text so public certificates pass but private keys block", () => {
    expect(
      scanTextArtifact(
        "certificate.pem",
        "application/x-pem-file",
        new TextEncoder().encode("-----BEGIN CERTIFICATE-----")
      )
    ).toBeNull();
    expect(
      scanTextArtifact(
        "certificate.pem",
        "application/x-pem-file",
        new TextEncoder().encode(PRIVATE_KEY_MARKER)
      )
    ).toBe("credential_pattern");
  });

  it("keeps adversarial repeated labels bounded in a child process", () => {
    const modulePath = fileURLToPath(
      new URL("./artifact-safety.ts", import.meta.url)
    );
    const script = `
      import assert from "node:assert/strict";
      import { scanTextArtifact } from ${JSON.stringify(modulePath)};
      const repeated = "password=".repeat(16_000) + " invalid prose";
      const separated = "login password" + " ".repeat(64_000) + "x";
      const hyphenated = "password-".repeat(16_000) + "x";
      for (const input of [repeated, separated, hyphenated]) {
        assert.equal(scanTextArtifact("report.txt", "text/plain", new TextEncoder().encode(input)), null);
      }
      console.log("ok");
    `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
        timeout: 3000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});
