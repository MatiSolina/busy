import { createHash } from "node:crypto";

/**
 * eve 0.91's name for a session's sandbox: the fallback for sessions that never reported their real
 * name (H-18). templates/bot/agent/lib/sandbox-name-compat.test.ts compares it with the installed
 * eve. No hub imports, so the template's suite can load it.
 */
export const sandboxName = (sessionId: string) =>
  `eve-sbx-vercel-${createHash("sha256")
    .update(JSON.stringify({ sessionId, version: 2 }))
    .digest("hex")
    .slice(0, 32)}`;
