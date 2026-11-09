"use client";

import dynamic from "next/dynamic";
import { type Ref, useCallback, useMemo } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { useChat, useSelectBot, useStore } from "@/components/chat-app";
import { useSections } from "@/components/sections-provider";
import { consultedBy } from "@/lib/chat/client-store";
import {
  type ClientRow,
  isWaitingForInput,
  toChatView,
} from "@/lib/chat/items";
import { isWorking } from "@/lib/chat/status";
import { cn } from "@/lib/utils";

const DraggableBotRow = dynamic(() =>
  import("@/components/draggable-bot-row").then((m) => m.DraggableBotRow)
);

const EMPTY_ROWS: readonly ClientRow[] = [];
const EMPTY_DELTAS: ReadonlyMap<string, string> = new Map();
const EMPTY_CONSULTS: ReadonlyMap<string, { id: string; peerName: string }> =
  new Map();

export interface SidebarBotRowProps {
  collapsed?: boolean;
  onSelect?: () => void;
  slug: string;
}

export function SidebarBotRow(props: SidebarBotRowProps) {
  const { busy, sections } = useSections();
  if (busy || props.collapsed || sections.length === 0) {
    return <BotRowContent {...props} />;
  }
  return <DraggableBotRow {...props} />;
}

export function BotRowContent({
  canDrag = false,
  collapsed = false,
  dragRef,
  dragging = false,
  onSelect,
  slug,
}: SidebarBotRowProps & {
  canDrag?: boolean;
  dragRef?: Ref<HTMLButtonElement>;
  dragging?: boolean;
}) {
  const store = useStore();
  const select = useSelectBot();
  const bot = useChat((state) => state.bots[slug]?.bot);
  const selected = useChat((state) => state.selected === slug);
  const rows = useChat((state) => state.bots[slug]?.rows ?? EMPTY_ROWS);
  const waitingForInput = useMemo(
    () =>
      isWaitingForInput(toChatView(rows, EMPTY_DELTAS, EMPTY_CONSULTS).items),
    [rows]
  );
  const rawWorking = useChat(
    (state) =>
      isWorking(state.bots[slug]?.rows ?? EMPTY_ROWS) ||
      consultedBy(state, slug) !== null
  );
  const working = rawWorking && !waitingForInput;
  const onClick = useCallback(() => {
    select(slug);
    onSelect?.();
  }, [onSelect, select, slug]);
  const preload = useCallback(() => store.preload(slug), [slug, store]);
  if (!bot) {
    return null;
  }
  let status: string | null = null;
  if (bot.status === "ready") {
    if (waitingForInput) {
      status = "Waiting for you";
    } else if (working) {
      status = "Working";
    }
  } else {
    status = bot.status === "failed" ? "Couldn't create" : "Setting up";
  }

  return (
    <li>
      <div
        className={cn(
          "group/bot flex min-w-0 items-center transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/60",
          dragging && "opacity-35"
        )}
      >
        <button
          aria-current={selected ? "page" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left",
            collapsed && "justify-center",
            canDrag &&
              "cursor-grab touch-pan-y select-none active:cursor-grabbing"
          )}
          data-bot-slug={slug}
          onClick={onClick}
          onFocus={preload}
          onPointerEnter={preload}
          ref={dragRef}
          title={
            collapsed
              ? [bot.name, status].filter(Boolean).join(" · ")
              : undefined
          }
          type="button"
        >
          <BotAvatar
            avatar={bot.avatar}
            size={28}
            slug={slug}
            working={working}
          />
          <span className={collapsed ? "sr-only" : "flex min-w-0 flex-col"}>
            <span className="truncate text-sm font-medium">{bot.name}</span>
            {status ? (
              <span
                className={cn(
                  "text-muted-foreground truncate text-[13px]",
                  waitingForInput && "text-signal",
                  bot.status !== "failed" && !waitingForInput && "text-shimmer"
                )}
              >
                {status}
              </span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );
}
