"use client";

import { Menu } from "@base-ui/react/menu";
import {
  ChevronRight,
  ChevronsUpDown,
  Grid2x2Plus,
  LoaderCircle,
  LogOut,
  Settings,
} from "lucide-react";
import dynamic from "next/dynamic";
import { Suspense, useCallback, useState } from "react";
import { AccountAiMenuContent } from "@/components/account-ai-connection";
import { AccountAvatar } from "@/components/account-avatar";
import { useAccount } from "@/components/account-provider";
import { MountOnOpen } from "@/components/mount-on-open";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const AccountSettingsDialog = dynamic(() =>
  import("@/components/account-settings-dialog").then(
    (m) => m.AccountSettingsDialog
  )
);

const menuItemClass =
  "flex cursor-default items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none data-highlighted:bg-accent data-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

export function SidebarAccount({
  onOpenMarketplace,
  collapsed = false,
}: {
  onOpenMarketplace: () => void;
  collapsed?: boolean;
}) {
  const { data, loading } = useAccount();
  const [settings, setSettings] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const name = data?.account.name ?? "Account";
  const logoutLabel = signingOut ? "Signing out…" : "Sign out";
  const openSettings = useCallback(() => setSettings(true), []);
  const preloadSettings = useCallback((open: boolean) => {
    if (open) {
      import("@/components/account-settings-dialog").catch(() => undefined);
    }
  }, []);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    setLogoutError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        throw new Error("Sign out failed");
      }
      // Discard mounted chat streams and the authenticated router cache on sign out.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    } catch {
      setSigningOut(false);
      setLogoutError("Couldn't sign out. Try again.");
    }
  }, []);

  return (
    <>
      <div className="border-border mx-3 border-t pt-3 pb-3">
        <div
          className={cn(
            "flex items-center gap-1",
            collapsed && "flex-col gap-2"
          )}
        >
          <Menu.Root onOpenChange={preloadSettings}>
            <Menu.Trigger
              aria-label={`Account menu: ${name}`}
              className={cn(
                "hover:bg-accent data-popup-open:bg-accent flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-2 text-left transition-colors",
                collapsed && "flex-none justify-center"
              )}
              disabled={signingOut}
              title={collapsed ? `Account menu: ${name}` : undefined}
            >
              <AccountMenuIdentity
                collapsed={collapsed}
                loading={loading}
                name={name}
              />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                align="start"
                className="z-50"
                side="top"
                sideOffset={8}
              >
                <Menu.Popup className="border-border bg-popover text-popover-foreground w-64 max-w-[calc(100vw-2rem)] origin-bottom-left rounded-xl border p-1.5 shadow-xl outline-none">
                  <Menu.Item className={menuItemClass} onClick={openSettings}>
                    <AccountAiMenuContent />
                    <ChevronRight aria-hidden="true" />
                  </Menu.Item>
                  <Menu.Item className={menuItemClass} onClick={openSettings}>
                    <Settings aria-hidden="true" />
                    <span className="flex-1">Settings</span>
                  </Menu.Item>
                  <Menu.Separator className="bg-border mx-2 my-1.5 h-px" />
                  <Menu.Item
                    className={menuItemClass}
                    closeOnClick={false}
                    disabled={signingOut}
                    onClick={signOut}
                  >
                    {signingOut ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="animate-spin"
                      />
                    ) : (
                      <LogOut aria-hidden="true" />
                    )}
                    {logoutLabel}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <Button
            aria-label="Skills, plugins and MCPs"
            className="text-muted-foreground shrink-0"
            onClick={onOpenMarketplace}
            size="icon-lg"
            title="Skills, plugins and MCPs"
            variant="outline"
          >
            <Grid2x2Plus aria-hidden="true" className="size-4" />
          </Button>
        </div>
        {logoutError ? (
          <p className="text-destructive px-2 pt-2 text-xs" role="alert">
            {logoutError}
          </p>
        ) : null}
      </div>

      <MountOnOpen open={settings}>
        <Suspense
          fallback={
            <SettingsLoading onOpenChange={setSettings} open={settings} />
          }
        >
          <AccountSettingsDialog onOpenChange={setSettings} open={settings} />
        </Suspense>
      </MountOnOpen>
    </>
  );
}
function SettingsLoading({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[min(640px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(960px,calc(100vw-2rem))]">
        <DialogHeader className="border-border border-b px-5 py-4 pr-12">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Loading settings…</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}

function AccountMenuIdentity({
  collapsed,
  loading,
  name,
}: {
  collapsed: boolean;
  loading: boolean;
  name: string;
}) {
  return (
    <>
      <AccountAvatar />
      <span
        className={
          collapsed ? "sr-only" : "min-w-0 flex-1 truncate text-sm font-medium"
        }
      >
        {loading ? <span>Loading account…</span> : <span>{name}</span>}
      </span>
      {collapsed ? null : (
        <ChevronsUpDown
          aria-hidden="true"
          className="text-muted-foreground size-3.5 shrink-0"
        />
      )}
    </>
  );
}
