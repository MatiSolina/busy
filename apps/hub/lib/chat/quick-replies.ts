export const QUICK_REPLIES_MAX = 3;
export const QUICK_REPLY_MAX_LENGTH = 40;

export type QuickRepliesResult =
  | { ok: true; replies: string[] }
  | { ok: false; reason: string };

// Same rules the bot applies when the model calls suggest_replies (templates/bot/agent/lib/quick-replies.ts),
// copied because the bot template is bundled on its own. The chat draws chips only from a list that passes.
export function parseQuickReplies(input: unknown): QuickRepliesResult {
  const list =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { replies?: unknown }).replies
      : undefined;
  if (!Array.isArray(list) || list.some((reply) => typeof reply !== "string")) {
    return { ok: false, reason: "replies must be a list of strings." };
  }
  const seen = new Set<string>();
  const replies: string[] = [];
  for (const raw of list as string[]) {
    const reply = raw.replace(/\s+/gu, " ").trim();
    const key = reply.toLowerCase();
    if (!reply || seen.has(key)) {
      continue;
    }
    seen.add(key);
    replies.push(reply);
  }
  if (replies.length === 0) {
    return { ok: false, reason: "no reply given." };
  }
  if (replies.length > QUICK_REPLIES_MAX) {
    return {
      ok: false,
      reason: `${replies.length} replies given, ${QUICK_REPLIES_MAX} at most.`,
    };
  }
  const tooLong = replies.find(
    (reply) => reply.length > QUICK_REPLY_MAX_LENGTH
  );
  if (tooLong) {
    return {
      ok: false,
      reason: `"${tooLong}" is longer than ${QUICK_REPLY_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, replies };
}
