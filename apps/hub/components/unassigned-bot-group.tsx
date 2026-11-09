"use client";
import { useDragOperation } from "@dnd-kit/react";
import {
  BOT_DRAG_TYPE,
  BotSectionDropZone,
} from "@/components/bot-sections-drag";
import { SidebarBotRow } from "@/components/sidebar-bot-row";

export function UnassignedBotGroup({
  onSelect,
  slugs,
}: {
  onSelect?: () => void;
  slugs: string[];
}) {
  const { source } = useDragOperation();
  if (slugs.length === 0 && source?.type !== BOT_DRAG_TYPE) {
    return null;
  }
  return (
    <BotSectionDropZone name="No section" sectionId={null}>
      <div className="text-muted-foreground flex h-9 items-center gap-2 px-3 text-sm">
        <span className="flex-1">No section</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {slugs.map((slug) => (
          <SidebarBotRow key={slug} onSelect={onSelect} slug={slug} />
        ))}
      </ul>
    </BotSectionDropZone>
  );
}
