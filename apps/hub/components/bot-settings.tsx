"use client";

import { Tabs } from "@base-ui/react/tabs";
import {
  Brain,
  Clock3,
  History,
  Library,
  MonitorPlay,
  Settings2,
} from "lucide-react";
import dynamic from "next/dynamic";
import { Activity, useCallback, useState } from "react";
import { MountOnOpen } from "@/components/mount-on-open";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { BotLite } from "@/lib/chat/client-store";

const BotForm = dynamic(() =>
  import("@/components/bot-dialog").then((m) => m.BotForm)
);
const LibraryResults = dynamic(() =>
  import("@/components/library-panel").then((m) => m.LibraryResults)
);
const RoutinesContent = dynamic(() =>
  import("@/components/routines-panel").then((m) => m.RoutinesContent)
);
const MemorySheet = dynamic(() =>
  import("@/components/memory-sheet").then((m) => m.MemorySheet)
);
const HistorySearch = dynamic(() =>
  import("@/components/history-sheet").then((m) => m.HistorySearch)
);
const LiveView = dynamic(() =>
  import("@/components/live-view").then((m) => m.LiveView)
);

const sections = [
  { icon: Settings2, label: "General", value: "general" },
  { icon: MonitorPlay, label: "Live", value: "live" },
  { icon: Library, label: "Library", value: "library" },
  { icon: Clock3, label: "Routines", value: "routines" },
  { icon: Brain, label: "Memory", value: "memory" },
  { icon: History, label: "History", value: "history" },
] as const;

interface BotSettingsProps {
  bot: BotLite;
  loggingIn: boolean;
  onLoginDone?: () => Promise<boolean> | boolean | undefined;
  onOpenChange: (open: boolean) => void;
  /** Sends the Teach recording's message to the bot's chat (Live's Teach control). */
  onTeachDone?: (message: string) => void;
  open: boolean;
  working: boolean;
}

export function BotSettings(props: BotSettingsProps) {
  const [session, setSession] = useState(0);
  const reset = useCallback((open: boolean) => {
    if (!open) {
      setSession((value) => value + 1);
    }
  }, []);
  return (
    <Sheet
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={reset}
      open={props.open}
    >
      <BotSettingsContent key={`${props.bot.slug}:${session}`} {...props} />
    </Sheet>
  );
}

function BotSettingsContent({
  bot,
  open,
  onOpenChange,
  ...liveProps
}: BotSettingsProps) {
  const [tab, setTab] = useState<string | number | null>("general");
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <SheetContent className="min-h-0 gap-0 overflow-hidden data-[side=right]:h-dvh data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
      <SheetHeader className="border-border border-b pr-12">
        <SheetTitle>{bot.name} settings</SheetTitle>
        <SheetDescription className="sr-only">
          Manage this bot, its computer, files, routines, memory and history.
        </SheetDescription>
      </SheetHeader>
      <Tabs.Root
        className="flex min-h-0 flex-1 flex-col"
        onValueChange={setTab}
        value={tab}
      >
        <Tabs.List
          aria-label="Bot settings sections"
          className="border-border grid shrink-0 grid-cols-3 gap-1 border-b p-2 sm:grid-cols-6"
        >
          {sections.map(({ icon: Icon, label, value }) => (
            <Tabs.Tab
              className="text-muted-foreground hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground flex min-h-9 items-center justify-center gap-2 px-2 text-xs outline-none disabled:pointer-events-none disabled:opacity-40 sm:text-sm"
              disabled={value === "live" && bot.status !== "ready"}
              key={value}
              value={value}
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              {label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {sections.map(({ value }) => (
          <Tabs.Panel
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none data-hidden:hidden"
            keepMounted
            key={value}
            value={value}
          >
            <MountOnOpen open={open && tab === value}>
              <Activity mode={open && tab === value ? "visible" : "hidden"}>
                {value === "general" ? (
                  <BotForm bot={bot} hideHeader onDone={close} />
                ) : null}
                {value === "live" && open && tab === value ? (
                  <LiveSection bot={bot} {...liveProps} />
                ) : null}
                {value === "library" ? (
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <LibraryResults slug={bot.slug} />
                  </div>
                ) : null}
                {value === "routines" ? (
                  <RoutinesContent
                    name={bot.name}
                    open={open && tab === value}
                    slug={bot.slug}
                  />
                ) : null}
                {value === "memory" ? (
                  <MemorySheet
                    embedded
                    name={bot.name}
                    onOpenChange={onOpenChange}
                    open={open && tab === value}
                    slug={bot.slug}
                  />
                ) : null}
                {value === "history" ? <HistorySearch slug={bot.slug} /> : null}
              </Activity>
            </MountOnOpen>
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </SheetContent>
  );
}

function LiveSection({
  bot,
  ...props
}: Pick<
  BotSettingsProps,
  "bot" | "loggingIn" | "onLoginDone" | "onTeachDone" | "working"
>) {
  const [mode, setMode] = useState<"observe" | "control" | null>("observe");
  return (
    <LiveView
      avatar={bot.avatar}
      embedded
      hideTrigger
      name={bot.name}
      onOpenChange={setMode}
      open={mode}
      slug={bot.slug}
      {...props}
    />
  );
}
