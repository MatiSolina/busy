"use client";

import { createContext, type ReactNode, use, useEffect, useState } from "react";
import type { AccountSnapshot } from "@/lib/account";

const AccountContext = createContext<{
  data: AccountSnapshot | null;
  loading: boolean;
  error: boolean;
} | null>(null);

async function fetchAccount(signal: AbortSignal): Promise<AccountSnapshot> {
  const response = await fetch("/api/account", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error("Account unavailable");
  }
  const account = (await response.json()) as Partial<AccountSnapshot>;
  if (!(account.account && account.tokenPass)) {
    throw new Error("Account unavailable");
  }
  return account as AccountSnapshot;
}

/** Desktop and mobile share one account request and refresh only while Busy is visible. */
export function AccountProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AccountSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending || document.visibilityState === "hidden") {
        return;
      }
      pending = true;
      try {
        const account = await fetchAccount(controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        setData(account as AccountSnapshot);
        setError(false);
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }
    load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    const interval = window.setInterval(load, 60_000);
    return () => {
      controller.abort();
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
      window.clearInterval(interval);
    };
  }, []);

  return (
    <AccountContext value={{ data, error, loading }}>{children}</AccountContext>
  );
}

export function useAccount() {
  const account = use(AccountContext);
  if (!account) {
    throw new Error("AccountProvider is missing");
  }
  return account;
}
