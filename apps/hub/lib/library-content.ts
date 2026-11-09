import { createHash } from "node:crypto";

/** A SHA-256 digest in the lowercase hexadecimal form used by library objects. */
export const SHA256_RE = /^[a-f0-9]{64}$/u;

export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return SHA256_RE.test(normalized) ? normalized : null;
}

/** Hash bytes without trusting a browser supplied digest. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hash a Blob response as it streams through the server. This keeps the upload
 * path direct to Blob while making completion server-authoritative: the hash
 * must come from the bytes stored by Blob, never from a request body field.
 */
export async function sha256Response(
  response: Response,
  expectedSize?: number
): Promise<{ sha256: string; size: number }> {
  if (!(response.ok && response.body)) {
    throw new Error("could not read uploaded file");
  }

  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: A stream reader must consume chunks in order.
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (expectedSize !== undefined && size > expectedSize) {
        throw new Error("uploaded file is larger than its reservation");
      }
      hash.update(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (expectedSize !== undefined && size !== expectedSize) {
    throw new Error("uploaded file size does not match its reservation");
  }
  return { sha256: hash.digest("hex"), size };
}

/** Stable, content-addressed Blob pathname. The digest is never a user path. */
export function objectPathForSha256(sha256: string): string {
  const normalized = normalizeSha256(sha256);
  if (!normalized) {
    throw new Error("invalid SHA-256 digest");
  }
  return `library/sha256/${normalized.slice(0, 2)}/${normalized}`;
}

export interface LibraryObject {
  contentType: string;
  createdAt: Date;
  pathname: string;
  sha256: string;
  size: number;
}

/**
 * References carry presentation and authorization context while objects carry
 * bytes. Keeping these concepts separate lets two bots share bytes without
 * sharing each other's references or chat history.
 */
export interface LibraryReference {
  botId: string;
  fileId: string;
  messageId?: string | null;
  sessionId?: string | null;
  source: "bot" | "user";
  turnId?: string | null;
}
