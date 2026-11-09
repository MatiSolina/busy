"use client";

import { Menu, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { BotSections } from "@/components/bot-sections";
import { BusyMark } from "@/components/busy-mark";
import { MountOnOpen } from "@/components/mount-on-open";
import { SidebarAccount } from "@/components/sidebar-account";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const NOOP = () => undefined;
const BotDialog = dynamic(() =>
  import("@/components/bot-dialog").then((m) => m.BotDialog)
);
const McpMarketplace = dynamic(() =>
  import("@/components/mcp-marketplace").then((m) => m.McpMarketplace)
);
const NOOP_SUBSCRIBE = () => () => undefined;

function electronShellSnapshot(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent.includes("Electron/")
  );
}

function useElectronShell(): boolean {
  return useSyncExternalStore(
    NOOP_SUBSCRIBE,
    electronShellSnapshot,
    () => false
  );
}

function subscribeLocation(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

function callbackMarketplaceOpen(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const result = params.get("mcp");
  return Boolean(result);
}

function useCallbackMarketplaceOpen(): boolean {
  return useSyncExternalStore(
    subscribeLocation,
    callbackMarketplaceOpen,
    () => false
  );
}

function clearMcpCallback() {
  if (typeof window === "undefined") {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (!params.has("mcp")) {
    return;
  }
  params.delete("mcp");
  const next = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${next ? `?${next}` : ""}`
  );
  window.dispatchEvent(new Event("popstate"));
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [marketplace, setMarketplace] = useState(false);
  const electronShell = useElectronShell();
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const toggleSidebar = useCallback(() => setCollapsed((value) => !value), []);
  const openMarketplace = useCallback(() => setMarketplace(true), []);
  const callbackOpen = useCallbackMarketplaceOpen();
  const marketplaceOpen = marketplace || callbackOpen;
  const onMarketplaceOpenChange = useCallback(
    (open: boolean) => {
      setMarketplace(open);
      if (!open && callbackOpen) {
        clearMcpCallback();
      }
    },
    [callbackOpen]
  );
  useEffect(() => {
    const handleMarketplaceEvent = () => setMarketplace(true);
    window.addEventListener("busy:open-marketplace", handleMarketplaceEvent);
    return () =>
      window.removeEventListener(
        "busy:open-marketplace",
        handleMarketplaceEvent
      );
  }, []);
  return (
    <aside
      className="hidden min-h-0 w-[272px] flex-col data-[collapsed=true]:w-20 motion-safe:transition-[width] motion-safe:duration-200 md:flex"
      data-collapsed={collapsed}
      data-desktop-shell={electronShell ? "electron" : undefined}
    >
      <div
        className={cn(
          "busy-titlebar flex h-14 shrink-0 items-center gap-2",
          collapsed ? "justify-center px-2" : "justify-between pr-3 pl-5"
        )}
      >
        <BusyMark className={cn(collapsed && "sr-only")} />
        <button
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          className="text-muted-foreground hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center bg-transparent transition-colors outline-none [&_svg]:size-4"
          onClick={toggleSidebar}
          title={toggleLabel}
          type="button"
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" />
          ) : (
            <PanelLeftClose aria-hidden="true" />
          )}
        </button>
      </div>
      <BotList collapsed={collapsed} onMarketplaceOpen={openMarketplace} />
      <MountOnOpen open={marketplaceOpen}>
        <McpMarketplace
          onOpenChange={onMarketplaceOpenChange}
          open={marketplaceOpen}
        />
      </MountOnOpen>
    </aside>
  );
}

/** On a phone the sidebar is a sheet behind a menu button, as Midday does. */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const openMenu = useCallback(() => setOpen(true), []);
  const closeMenu = useCallback(() => setOpen(false), []);
  const openMarketplace = useCallback(
    () => window.dispatchEvent(new Event("busy:open-marketplace")),
    []
  );
  return (
    <>
      <Button
        aria-label="Bots"
        className="shrink-0 rounded-full md:hidden"
        onClick={openMenu}
        size="icon-sm"
        variant="outline"
      >
        <Menu aria-hidden="true" />
      </Button>
      <MountOnOpen open={open}>
        <Sheet onOpenChange={setOpen} open={open}>
          <SheetContent className="w-[85%] gap-0 pt-3" side="left">
            <SheetTitle className="px-5 py-2 text-[15px] tracking-tight">
              Busy
            </SheetTitle>
            <SheetDescription className="sr-only">Your bots</SheetDescription>
            <BotList onMarketplaceOpen={openMarketplace} onSelect={closeMenu} />
          </SheetContent>
        </Sheet>
      </MountOnOpen>
    </>
  );
}

function BotList({
  onSelect,
  onMarketplaceOpen,
  collapsed = false,
}: {
  onSelect?: () => void;
  onMarketplaceOpen?: () => void;
  collapsed?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const createBot = useCallback(() => setCreating(true), []);
  return (
    <>
      <BotSections collapsed={collapsed} onSelect={onSelect} />
      <div className="p-2">
        <button
          className={cn(
            "text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
            collapsed && "justify-center"
          )}
          onClick={createBot}
          title={collapsed ? "Create bot" : undefined}
          type="button"
        >
          <Plus aria-hidden="true" className="size-4 shrink-0" />
          <span className={cn(collapsed && "sr-only")}>Create bot</span>
        </button>
      </div>
      <SidebarAccount
        collapsed={collapsed}
        onOpenMarketplace={onMarketplaceOpen ?? NOOP}
      />
      <MountOnOpen open={creating}>
        <BotDialog onOpenChange={setCreating} open={creating} />
      </MountOnOpen>
    </>
  );
}
