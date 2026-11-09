import type { PublicSubscriptionAttempt } from "./subscription-types";

export interface BusyDesktopSubscriptions {
  cancelChatGpt: () => Promise<void>;
  openChatGpt: (attempt: PublicSubscriptionAttempt) => Promise<void>;
  prepareChatGpt: () => Promise<{ redirectUri: string }>;
}

export interface BusyDesktopBridge {
  subscriptions?: BusyDesktopSubscriptions;
}

declare global {
  interface Window {
    busyDesktop?: BusyDesktopBridge;
  }
}

export function desktopSubscriptions(): BusyDesktopSubscriptions | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.busyDesktop?.subscriptions ?? null;
}
