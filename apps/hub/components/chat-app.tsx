"use client";

import {
  Activity,
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { AccountProvider } from "@/components/account-provider";
import { AiConnectionProvider } from "@/components/ai-connection-provider";
import { AiOnboarding } from "@/components/ai-onboarding";
import { BotPaneTransition } from "@/components/bot-pane-transition";
import { ChatPane } from "@/components/chat-pane";
import { SectionsProvider } from "@/components/sections-provider";
import { MobileMenu, Sidebar } from "@/components/sidebar";
import {
  type BotLite,
  type ChatState,
  type ChatStore,
  createChatStore,
  type InitialBotLite,
} from "@/lib/chat/client-store";
import { warmMarkdownWorker } from "@/lib/chat/markdown-client";
import { createChatRum, rumEnabled } from "@/lib/rum/client";
import type { Section } from "@/lib/sections/types";

const StoreContext = createContext<ChatStore | null>(null);

export function useStore(): ChatStore {
  const store = use(StoreContext);
  if (!store) {
    throw new Error("ChatApp is missing");
  }
  return store;
}

/** Subscribe to one derived value; components re-render only when it changes. */
export function useChat<T>(selector: (s: ChatState) => T): T {
  const store = useStore();
  const get = () => selector(store.getState());
  const getServer = () => selector(store.getServerState());
  return useSyncExternalStore(store.subscribe, get, getServer);
}

/** Switch immediately; the pane's reveal animates without remounting its chat. */
export function useSelectBot() {
  const store = useStore();
  return (slug: string) => {
    window.history.replaceState(null, "", `/b/${encodeURIComponent(slug)}`);
    if (store.getState().selected === slug) {
      return;
    }
    store.select(slug);
  };
}

export function ChatApp({
  initial,
  initialSections,
  selected,
}: {
  initial: InitialBotLite[];
  initialSections?: Section[];
  selected?: string;
}) {
  const [store] = useState(() =>
    createChatStore(
      initial,
      {
        fetch: (...a) => fetch(...a),
        open: (url) => new EventSource(url),
        rum: rumEnabled() ? createChatRum() : undefined,
      },
      selected
    )
  );

  useEffect(() => {
    store.resumeStreams();
    const { selected: selectedBot } = store.getState();
    if (selectedBot) {
      store.select(selectedBot);
    }
    warmMarkdownWorker();
    // Every chat loads in the background, so opening one shows it at once instead of a loading line.
    // ponytail: all bots in parallel; cap it if a workspace grows to dozens of bots.
    for (const slug of store.getState().order) {
      store.preload(slug).catch(() => undefined);
    }
    return () => {
      store.pauseStreams();
    };
  }, [store]);

  return (
    <StoreContext value={store}>
      <AiConnectionProvider>
        <AccountProvider>
          <SectionsProvider initial={initialSections}>
            <div className="bg-background grid h-dvh grid-cols-1 overflow-hidden md:grid-cols-[auto_minmax(0,1fr)]">
              <Sidebar />
              <Panes />
              <DeployWatcher />
            </div>
            <AiOnboarding />
          </SectionsProvider>
        </AccountProvider>
      </AiConnectionProvider>
    </StoreContext>
  );
}

// Every chat stays mounted; hidden ones keep their scroll, draft and live stream (rendering-activity).
function Panes() {
  const order = useChat((s) => s.order);
  const selected = useChat((s) => s.selected);
  const [visited, setVisited] = useState(
    () => new Set(selected ? [selected] : [])
  );
  if (selected && !visited.has(selected)) {
    setVisited(new Set([...visited, selected]));
  }
  return (
    <main className="border-border relative min-w-0 md:border-l">
      {order.length === 0 ? (
        <NoBots />
      ) : (
        order
          .filter((slug) => slug === selected || visited.has(slug))
          .map((slug) => (
            <Activity
              key={slug}
              mode={slug === selected ? "visible" : "hidden"}
            >
              <BotPaneTransition>
                <ChatPane slug={slug} />
              </BotPaneTransition>
            </Activity>
          ))
      )}
    </main>
  );
}

/** Polls bots that are deploying until they're ready. It lives here, not in their pane: a hidden pane's effects don't run. */
function DeployWatcher() {
  const store = useStore();
  const deploying = useChat((state) => {
    const slugs = state.order.filter((slug) => {
      const bot = state.bots[slug];
      return bot && !["ready", "failed"].includes(bot.bot.status);
    });
    return slugs.join(" ");
  });
  useEffect(() => {
    if (!deploying) {
      return;
    }
    const poll = () => {
      for (const slug of deploying.split(" ")) {
        fetch(`/api/bots/${encodeURIComponent(slug)}`)
          .then(async (res) => {
            const bot = res.ok ? ((await res.json()) as BotLite) : null;
            // Deleted while this poll was in flight: its late answer mustn't bring it back.
            if (bot && store.getState().bots[slug]) {
              store.upsertBot(bot);
            }
          })
          .catch(() => undefined);
      }
    };
    // Right away, so the deploy steps show without waiting a full interval.
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [deploying, store]);
  return null;
}

function NoBots() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="absolute top-3 left-3">
        <MobileMenu />
      </div>
      <p className="font-pixel text-3xl leading-none">No bots yet</p>
      <p className="text-muted-foreground max-w-sm text-sm">
        Create one from the sidebar. Each bot has its own computer and memory,
        and can consult the others.
      </p>
    </div>
  );
}
