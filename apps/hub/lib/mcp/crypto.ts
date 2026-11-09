import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PAYLOAD_BYTES = 512 * 1024;

function keyFor(secret: string): Buffer {
  if (!secret || secret.length < 16) {
    throw new Error("MCP OAuth encryption secret is too short");
  }
  return createHash("sha256")
    .update("busy:mcp-oauth:v1\0")
    .update(secret)
    .digest();
}

function aadFor(connectionId: string): Buffer {
  if (!connectionId || connectionId.length > 200) {
    throw new Error("MCP OAuth connection id is invalid");
  }
  return Buffer.from(`busy:mcp-oauth:${connectionId}`, "utf8");
}

/** Encrypt OAuth metadata and tokens with AES-256-GCM bound to a connection id. */
export function encryptOAuth<T>(
  data: T,
  connectionId: string,
  secret: string
): string {
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("MCP OAuth payload is too large");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  cipher.setAAD(aadFor(connectionId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Decrypt and authenticate a payload; no token-bearing details escape errors. */
export function decryptOAuth<T>(
  sealed: string,
  connectionId: string,
  secret: string
): T {
  try {
    const [version, ivText, tagText, ciphertextText, ...extra] =
      sealed.split(".");
    if (
      version !== VERSION ||
      extra.length ||
      !ivText ||
      !tagText ||
      !ciphertextText
    ) {
      throw new Error("malformed");
    }
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    const ciphertext = Buffer.from(ciphertextText, "base64url");
    if (
      iv.length !== IV_BYTES ||
      tag.length !== TAG_BYTES ||
      ciphertext.length > MAX_PAYLOAD_BYTES
    ) {
      throw new Error("malformed");
    }
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
    decipher.setAAD(aadFor(connectionId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
      throw new Error("oversized");
    }
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    // biome-ignore lint/style/useErrorCause: Sealed payload errors intentionally hide ciphertext details.
    throw new Error("Invalid sealed MCP OAuth payload");
  }
}
