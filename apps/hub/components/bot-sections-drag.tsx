"use client";

import {
  DragDropProvider,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
} from "@dnd-kit/react";
import { type ReactNode, useCallback, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { useChat, useStore } from "@/components/chat-app";
import { useSections } from "@/components/sections-provider";
import { cn } from "@/lib/utils";

export const BOT_DRAG_TYPE = "busy-bot";

// Enter keeps its normal action of opening a chat; Space starts a keyboard drag.
const sensors = [
  PointerSensor,
  KeyboardSensor.configure({
    keyboardCodes: {
      ...KeyboardSensor.defaults.keyboardCodes,
      start: ["Space"],
    },
  }),
];

export function BotSectionsDrag({ children }: { children: ReactNode }) {
  const { busy, moveBot, sections } = useSections();
  const store = useStore();
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);
  const drop = useCallback(
    async (event: DragEndEvent) => {
      if (event.canceled || busy) {
        return;
      }
      const { source, target } = event.operation;
      const slug = source?.data.slug;
      const sectionId = target?.data.sectionId;
      if (
        source?.type !== BOT_DRAG_TYPE ||
        typeof slug !== "string" ||
        !store.getState().bots[slug] ||
        !target ||
        !(
          sectionId === null ||
          (typeof sectionId === "string" &&
            sections.some((section) => section.id === sectionId))
        )
      ) {
        return;
      }
      const previous = sections.find((section) =>
        section.botSlugs.includes(slug)
      );
      if ((previous?.id ?? null) === sectionId) {
        return;
      }
      setError(null);
      try {
        await moveBot(slug, sectionId);
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Couldn't move the bot. Try again."
        );
      }
    },
    [busy, moveBot, sections, store]
  );

  return (
    <DragDropProvider
      onDragEnd={drop}
      onDragStart={clearError}
      sensors={sensors}
    >
      {children}
      {error ? (
        <p className="text-destructive px-5 py-2 text-xs" role="alert">
          {error}
        </p>
      ) : null}
      <DragOverlay className="pointer-events-none z-40" dropAnimation={null}>
        {renderBotPreview}
      </DragOverlay>
    </DragDropProvider>
  );
}

function renderBotPreview(
  source: NonNullable<DragEndEvent["operation"]["source"]>
) {
  return <BotDragPreview slug={String(source.data.slug)} />;
}

function BotDragPreview({ slug }: { slug: string }) {
  const bot = useChat((state) => state.bots[slug]?.bot);
  if (!bot) {
    return null;
  }
  return (
    <div
      aria-hidden
      className="bg-popover text-popover-foreground border-border flex items-center gap-3 border px-3 py-2 shadow-xl"
    >
      <BotAvatar avatar={bot.avatar} size={28} slug={slug} />
      <span className="truncate text-sm font-medium">{bot.name}</span>
    </div>
  );
}

export function BotSectionDropZone({
  children,
  name,
  sectionId,
}: {
  children: ReactNode;
  name: string;
  sectionId: string | null;
}) {
  const { busy } = useSections();
  const { isDropTarget, ref } = useDroppable({
    accept: BOT_DRAG_TYPE,
    data: { sectionId },
    disabled: busy,
    id: `section:${sectionId ?? "none"}`,
  });
  return (
    <section
      aria-label={name}
      className={cn(
        "min-h-9 transition-colors",
        isDropTarget && "bg-accent ring-ring ring-1 ring-inset"
      )}
      data-drop-target={isDropTarget || undefined}
      ref={ref}
    >
      {children}
    </section>
  );
}
