"use client";

import { Tabs } from "@base-ui/react/tabs";
import { BookOpen, BrainCircuit, Gauge, PlugZap, Puzzle } from "lucide-react";
import dynamic from "next/dynamic";
import { Activity, useCallback, useState, useSyncExternalStore } from "react";
import { AccountAiConnectionCard } from "@/components/account-ai-connection";
import { AccountAvatar } from "@/components/account-avatar";
import { useAccount } from "@/components/account-provider";
import { AiConnectionSettings } from "@/components/ai-connection-settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const McpMarketplaceContent = dynamic(
  () =>
    import("@/components/mcp-marketplace").then(
      (module) => module.McpMarketplaceContent
    ),
  {
    loading: () => (
      <p className="text-muted-foreground p-6 text-sm" role="status">
        Loading MCPs…
      </p>
    ),
  }
);

const CapabilitiesPanel = dynamic(
  () =>
    import("@/components/capabilities-panel").then(
      (module) => module.CapabilitiesPanel
    ),
  {
    loading: () => (
      <p className="text-muted-foreground p-6 text-sm" role="status">
        Loading…
      </p>
    ),
  }
);

const settingsTabs = [
  { icon: BrainCircuit, label: "Model", value: "model" },
  { icon: BookOpen, label: "Skills", value: "skills" },
  { icon: Puzzle, label: "Plugins", value: "plugins" },
  { icon: PlugZap, label: "MCPs", value: "mcps" },
  { icon: Gauge, label: "Usage", value: "usage" },
] as const;
const capabilitySections = [
  { kind: "skill", label: "Skills", value: "skills" },
  { kind: "plugin", label: "Plugins", value: "plugins" },
] as const;
const settingsSidebarQuery = "(min-width: 640px)";

function subscribeSettingsLayout(listener: () => void) {
  const media = window.matchMedia(settingsSidebarQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function hasSettingsSidebar() {
  return window.matchMedia(settingsSidebarQuery).matches;
}

const mobileSettingsLayout = () => false;

export function AccountSettingsDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { data, error } = useAccount();
  const [tab, setTab] = useState<string | number | null>("model");
  const [visitedSections, setVisitedSections] = useState<Set<string>>(
    () => new Set(["model"])
  );
  const sidebar = useSyncExternalStore(
    subscribeSettingsLayout,
    hasSettingsSidebar,
    mobileSettingsLayout
  );
  const changeTab = useCallback((value: string | number | null) => {
    setTab(value);
    if (typeof value === "string") {
      setVisitedSections((previous) =>
        previous.has(value) ? previous : new Set(previous).add(value)
      );
    }
  }, []);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[min(640px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(960px,calc(100vw-2rem))]">
        <DialogHeader className="border-border border-b px-5 py-4 pr-12">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Manage your model, skills, plugins, MCPs and usage.
          </DialogDescription>
        </DialogHeader>
        <Tabs.Root
          className="flex min-h-0 flex-1 flex-col sm:flex-row"
          onValueChange={changeTab}
          orientation={sidebar ? "vertical" : "horizontal"}
          value={tab}
        >
          <div className="border-border flex shrink-0 flex-col border-b sm:w-40 sm:border-r sm:border-b-0">
            <Tabs.List
              aria-label="Settings sections"
              className="flex gap-1 overflow-x-auto p-2 sm:flex-1 sm:flex-col sm:justify-start sm:overflow-visible sm:p-3"
            >
              {settingsTabs.map(({ icon: Icon, label, value }) => (
                <Tabs.Tab
                  className="text-muted-foreground hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground flex min-h-9 flex-1 items-center justify-center gap-2 px-2 text-left text-xs whitespace-nowrap outline-none sm:flex-none sm:justify-start sm:px-3 sm:text-sm"
                  key={value}
                  value={value}
                >
                  <Icon
                    aria-hidden
                    className="hidden size-4 shrink-0 sm:block"
                  />
                  {label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <div className="border-border hidden items-center gap-2 border-t p-3 sm:flex">
              <AccountAvatar />
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">
                  {data?.account.name ?? "Account"}
                </p>
                <p className="text-muted-foreground text-[11px]">
                  {error ? "Refresh unavailable" : "Signed in"}
                </p>
              </div>
            </div>
          </div>
          <Tabs.Panel
            className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 outline-none data-hidden:hidden sm:p-6"
            keepMounted
            value="model"
          >
            <AiConnectionSettings />
          </Tabs.Panel>
          {capabilitySections.map(({ kind, label, value }) => (
            <Tabs.Panel
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none data-hidden:hidden"
              keepMounted
              key={value}
              value={value}
            >
              {visitedSections.has(value) ? (
                <Activity mode={tab === value ? "visible" : "hidden"}>
                  <h3 className="px-4 pt-5 text-sm font-medium sm:px-6">
                    {label}
                  </h3>
                  <CapabilitiesPanel kind={kind} />
                </Activity>
              ) : null}
            </Tabs.Panel>
          ))}
          <Tabs.Panel
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none data-hidden:hidden"
            keepMounted
            value="mcps"
          >
            {visitedSections.has("mcps") ? (
              <Activity mode={tab === "mcps" ? "visible" : "hidden"}>
                <h3 className="px-4 pt-5 text-sm font-medium sm:px-6">MCPs</h3>
                <McpMarketplaceContent active={open && tab === "mcps"} />
              </Activity>
            ) : null}
          </Tabs.Panel>
          <Tabs.Panel
            className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 outline-none data-hidden:hidden sm:p-6"
            value="usage"
          >
            <h3 className="text-sm font-medium">Usage</h3>
            <p className="text-muted-foreground mt-1 mb-6 text-xs">
              Usage and billing for your saved connection.
            </p>
            <AccountAiConnectionCard variant="plain" />
          </Tabs.Panel>
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  );
}
