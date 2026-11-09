"use client";

import { type MouseEvent, useCallback } from "react";

/** One tap sends the reply as the user's message; writing anything else makes them go away (items.ts). */
export function QuickReplies({
  replies,
  onPick,
}: {
  replies: readonly string[];
  onPick: (text: string) => void;
}) {
  const pick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { reply } = event.currentTarget.dataset;
      if (reply) {
        onPick(reply);
      }
    },
    [onPick]
  );

  if (replies.length === 0) {
    return null;
  }

  return (
    <fieldset className="mx-auto flex w-full shrink-0 flex-wrap justify-end gap-2 px-6 pb-2">
      <legend className="sr-only">Suggested replies</legend>
      {replies.map((reply) => (
        <button
          className="animate-enter border-border bg-card hover:border-foreground/25 hover:bg-accent max-w-full truncate rounded-full border px-3 py-1.5 text-[13px] leading-5 transition-colors"
          data-reply={reply}
          key={reply}
          onClick={pick}
          type="button"
        >
          {reply}
        </button>
      ))}
    </fieldset>
  );
}
