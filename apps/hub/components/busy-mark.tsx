"use client";

import { PixHead } from "@/components/bot-avatar";
import { cn } from "@/lib/utils";

/** The redline yellow of the Busy mark's lights (--signal). */
export const BUSY_GLOW = "#ffd23f";

/**
 * The Busy lockup, as on busybot.dev: the outlined Pix head with redline
 * lights and the name in Geist Pixel. Its eyes follow the pointer.
 */
export function BusyMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <PixHead className="size-[22px]" glow={BUSY_GLOW} pix="lime" />
      <span className="font-pixel text-[19px] leading-none">busy</span>
    </span>
  );
}
