// Same set the bot's react tool offers (templates/bot/agent/tools/react.ts).
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "✅"] as const;
const ALLOWED = new Set<string>(REACTIONS);

export const REACT_TOOL = "react";

/** The emoji of a react call, or null when the input isn't one the chat shows. */
export function parseReaction(input: unknown): string | null {
  const emoji = (input as { emoji?: unknown } | null)?.emoji;
  return typeof emoji === "string" && ALLOWED.has(emoji) ? emoji : null;
}
