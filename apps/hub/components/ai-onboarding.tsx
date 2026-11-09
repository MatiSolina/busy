"use client";

import dynamic from "next/dynamic";
import { useCallback } from "react";
import { useAiConnectionOptional } from "@/components/ai-connection-provider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const AiProviderPicker = dynamic(
  () =>
    import("@/components/ai-connection-settings").then(
      (m) => m.AiProviderPicker
    ),
  { loading: () => <p role="status">Loading AI connections…</p> }
);

export function AiOnboarding() {
  const connection = useAiConnectionOptional();
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        connection?.dismissOnboarding();
      }
    },
    [connection]
  );
  if (!connection?.onboardingOpen) {
    return null;
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="grid max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-2xl p-0 sm:max-w-[min(900px,calc(100vw-2rem))]">
        <DialogHeader className="border-border border-b p-6 pr-12">
          <p className="text-muted-foreground text-xs font-medium tracking-[0.12em] uppercase">
            One choice before you start
          </p>
          <DialogTitle className="mt-1 text-xl tracking-tight">
            Choose your AI connection
          </DialogTitle>
          <DialogDescription>
            Busy needs an AI connection to think for your bots. Pick the option
            you already use, and you can change it later in Settings. You can
            close this window and finish the choice there if you need to
            reconnect a subscription first.
          </DialogDescription>
        </DialogHeader>
        <div className="p-5 sm:p-7">
          <AiProviderPicker
            actionLabel="Continue"
            connection={connection}
            presentation="onboarding"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
