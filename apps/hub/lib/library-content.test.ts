import { describe, expect, it } from "vitest";
import {
  normalizeSha256,
  objectPathForSha256,
  sha256Bytes,
  sha256Response,
} from "./library-content";

describe("content-addressed library helpers", () => {
  it("normalizes and validates digests", () => {
    const digest = sha256Bytes(new TextEncoder().encode("busy"));
    expect(normalizeSha256(`  ${digest.toUpperCase()} `)).toBe(digest);
    expect(normalizeSha256("sha256:bad")).toBeNull();
    expect(normalizeSha256("not-a-digest")).toBeNull();
  });

  it("uses a stable path that cannot contain user-controlled names", () => {
    const digest = sha256Bytes(new TextEncoder().encode("busy"));
    expect(objectPathForSha256(digest)).toBe(
      `library/sha256/${digest.slice(0, 2)}/${digest}`
    );
    expect(() => objectPathForSha256("bad")).toThrow("invalid SHA-256");
  });

  it("hashes the response stream and rejects a size mismatch", async () => {
    const bytes = new TextEncoder().encode("content-addressed");
    const response = new Response(bytes);
    await expect(sha256Response(response, bytes.byteLength)).resolves.toEqual({
      sha256: sha256Bytes(bytes),
      size: bytes.byteLength,
    });
    await expect(
      sha256Response(new Response(bytes), bytes.byteLength + 1)
    ).rejects.toThrow("size does not match");
  });
});
