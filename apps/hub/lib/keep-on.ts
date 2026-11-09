import { start } from "workflow/api";
import type { BotRow } from "@/lib/db";
import {
  extendHeldComputer,
  holdComputer,
  isWatched,
  markWatching,
} from "@/lib/live";
import { liveWatchWorkflow } from "@/workflows/live-watch";

/**
 * Keeps the bot's computer on `ms` more (and advances its generation, which invalidates any
 * shutdown claimed before). When it wasn't on, starts the watch that stops it once the time is up.
 */
export async function keepOn(
  bot: Pick<BotRow, "id" | "slug" | "liveUntil">,
  ms: number
): Promise<void> {
  if (!isWatched(bot)) {
    await start(liveWatchWorkflow, [bot.slug]).catch(() => {
      // A later cron run will observe the persisted liveUntil value.
    });
  }
  await markWatching(bot.id, ms);
}

/**
 * request_login's hold: keeps the session's computer up to LOGIN_HOLD_MS, extends its timeout now,
 * and starts a watch that keeps extending it while the hold lasts. Null for another session.
 */
export async function holdOn(
  bot: BotRow,
  sessionId: string
): Promise<Date | null> {
  const holdUntil = await holdComputer(bot, sessionId);
  if (!holdUntil) {
    return null;
  }
  // Always a watch of its own: one already running may be about to finish its last check.
  await start(liveWatchWorkflow, [bot.slug]).catch(() => {
    // The extension below still covers the next HOLD_MARGIN; the sandbox timeout bounds the rest.
  });
  await extendHeldComputer(bot, holdUntil).catch((error: unknown) => {
    console.warn("live: could not extend a held computer", {
      error,
      slug: bot.slug,
    });
  });
  return holdUntil;
}
