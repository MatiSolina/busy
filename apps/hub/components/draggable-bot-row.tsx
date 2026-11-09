"use client";
import { useDraggable } from "@dnd-kit/react";
import { BOT_DRAG_TYPE } from "@/components/bot-sections-drag";
import {
  BotRowContent,
  type SidebarBotRowProps,
} from "@/components/sidebar-bot-row";

export function DraggableBotRow(props: SidebarBotRowProps) {
  const { isDragSource, ref } = useDraggable({
    data: { slug: props.slug },
    id: `bot:${props.slug}`,
    type: BOT_DRAG_TYPE,
  });
  return (
    <BotRowContent {...props} canDrag dragging={isDragSource} dragRef={ref} />
  );
}
