"use client";

import { Tabs } from "@base-ui/react/tabs";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  LoaderCircle,
  PlugZap,
  Puzzle,
  Search,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import {
  Activity,
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { McpIntegrationDetails } from "@/components/mcp-integration-details";
import styles from "@/components/mcp-marketplace.module.css";
import { McpMarketplaceCard } from "@/components/mcp-marketplace-card";
import { groupMcpCatalog } from "@/components/mcp-marketplace-categories";
import {
  McpProviderSetup,
  type OAuthProvider,
  type ProviderSetupDetails,
} from "@/components/mcp-provider-setup";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

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

const capabilityTabs = [
  { icon: BookOpen, label: "Skills", value: "skills" },
  { icon: Puzzle, label: "Plugins", value: "plugins" },
  { icon: PlugZap, label: "MCPs", value: "mcps" },
] as const;
type CapabilityTab = (typeof capabilityTabs)[number]["value"];

export interface McpMarketplaceContentProps {
  active?: boolean;
}

/** A catalog item is intentionally metadata-only. Credentials never reach this component. */
export interface McpCatalogEntry {
  auth: "none" | "oauth";
  catalogHash?: string;
  catalogVersion?: string;
  configured?: boolean;
  description: string;
  docsUrl?: string;
  icon: string;
  id: string;
  lifecycle?: "active" | "deprecated";
  name: string;
  oauthProvider?: OAuthProvider;
  oauthScopes?: string;
  tools?: McpToolDescriptor[];
  transport: "http" | "sse";
  url?: string;
}

export interface McpToolDescriptor {
  description: string;
  destructiveHint?: boolean;
  name: string;
  readOnlyHint: boolean;
  ui?: {
    resourceUri?: string;
    visibility?: ("model" | "app")[];
  };
}

export interface PublicMcpConnection {
  aclMode?: "enforced" | "legacy";
  allowedTools?: string[];
  catalogHash?: string;
  catalogId: string;
  catalogVersion?: string;
  error: string | null;
  id: string;
  lifecycle?: "active" | "deprecated" | "update" | "removed";
  reauthRequired?: boolean;
  reviewedAt?: string;
  status: "pending" | "connected" | "error";
  tools?: McpToolDescriptor[];
}

interface MarketplaceResponse {
  catalog: McpCatalogEntry[];
  connections: PublicMcpConnection[];
}
const PENDING_FLOW_MAX_MS = 10 * 60 * 1000;

function callbackNotice(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const result = new URLSearchParams(window.location.search).get("mcp");
  if (!result) {
    return null;
  }
  return result === "connected"
    ? "MCP connected. Your app can use it now."
    : "MCP sign-in did not finish. Try again.";
}

function useCallbackNotice(): string | null {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
    callbackNotice,
    () => null
  );
}

interface Props {
  /** Optional test/navigation adapter; production opens the flow in a browser tab. */
  navigate?: (url: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

type MarketplaceCoreProps = Omit<Props, "onOpenChange"> & {
  active?: boolean;
  embedded?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type ToolUpdate = (
  entry: McpCatalogEntry,
  connection: PublicMcpConnection,
  allowedTools: string[]
) => Promise<void>;

type ToolDiscovery = (
  entry: McpCatalogEntry,
  connection: PublicMcpConnection
) => Promise<void>;

export type McpConnect = (
  entry: McpCatalogEntry,
  connection?: PublicMcpConnection
) => Promise<void>;

interface MarketplaceStateProps {
  catalogLength: number;
  connectionsFor: (catalogId: string) => PublicMcpConnection[];
  error: string | null;
  filter: "all" | "connected";
  filtered: McpCatalogEntry[];
  loading: boolean;
  onConnect: McpConnect;
  onReset: () => void;
  onRetry: () => void;
  onSelect: (id: string) => void;
  pending: Set<string>;
  query: string;
}

function emptyTitle(hasQuery: boolean, filter: "all" | "connected") {
  if (hasQuery) {
    return "No apps found";
  }
  if (filter === "connected") {
    return "No connected apps yet";
  }
  return "No apps available";
}

function emptyMessage(
  query: string,
  hasQuery: boolean,
  filter: "all" | "connected"
) {
  if (hasQuery) {
    return `No apps match “${query.trim()}”. Try another search.`;
  }
  if (filter === "connected") {
    return "Connect an app to make it available to your bots.";
  }
  return "Check back in a moment or try loading the catalog again.";
}

function sectionTitle(query: string, filter: "all" | "connected") {
  if (query.trim()) {
    return "Search results";
  }
  if (filter === "connected") {
    return "Your connections";
  }
  return "App connections";
}

function MarketplaceState({
  catalogLength,
  connectionsFor,
  error,
  filter,
  filtered,
  loading,
  onConnect,
  onSelect,
  onReset,
  onRetry,
  pending,
  query,
}: MarketplaceStateProps) {
  if (loading) {
    return (
      <div className={styles.empty} role="status">
        <LoaderCircle aria-hidden className="animate-spin" />
        <p>Loading apps…</p>
      </div>
    );
  }

  if (error && catalogLength === 0) {
    return (
      <div className={styles.empty} role="alert">
        <AlertCircle aria-hidden />
        <p>{error}</p>
        <Button onClick={onRetry} size="sm" variant="outline">
          Try again
        </Button>
      </div>
    );
  }

  if (filtered.length === 0) {
    const hasQuery = query.trim().length > 0;
    const EmptyIcon = hasQuery ? Search : PlugZap;
    const title = emptyTitle(hasQuery, filter);
    const message = emptyMessage(query, hasQuery, filter);

    return (
      <div className={styles.empty}>
        <EmptyIcon aria-hidden />
        <h3>{title}</h3>
        <p>{message}</p>
        {hasQuery || filter === "connected" ? (
          <Button onClick={onReset} size="sm" variant="outline">
            Browse all apps
          </Button>
        ) : (
          <Button onClick={onRetry} size="sm" variant="outline">
            Try again
          </Button>
        )}
      </div>
    );
  }

  const appCount = filtered.length === 1 ? "app" : "apps";
  const groups = groupMcpCatalog(filtered);

  return (
    <>
      <div className={styles.resultsHeader}>
        <h3>{sectionTitle(query, filter)}</h3>
        <span className={styles.count}>
          {filtered.length} {appCount}
        </span>
      </div>
      {groups.map(([categoryName, entries]) => (
        <section className={styles.categorySection} key={categoryName}>
          <h3 className={styles.categoryTitle}>{categoryName}</h3>
          <ul aria-label={categoryName} className={styles.grid}>
            {entries.map((entry) => (
              <McpMarketplaceCard
                busy={pending.has(entry.id)}
                connections={connectionsFor(entry.id)}
                entry={entry}
                key={entry.id}
                onConnect={onConnect}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

interface MarketplaceFeedbackProps {
  callbackStatus: string | null;
  catalogLength: number;
  error: string | null;
  notice: string | null;
}

function MarketplaceFeedback({
  callbackStatus,
  catalogLength,
  error,
  notice,
}: MarketplaceFeedbackProps) {
  if (!(notice || callbackStatus || (error && catalogLength > 0))) {
    return null;
  }
  return (
    <footer className={styles.footer}>
      {(notice ?? callbackStatus) ? (
        <p className="text-muted-foreground text-xs" role="status">
          {notice ?? callbackStatus}
        </p>
      ) : null}
      {error && catalogLength > 0 ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </footer>
  );
}

/**
 * Curated remote MCP connections for the app. OAuth is deliberately started by
 * the hub, so the browser never receives a provider secret or an access token.
 */
export function McpMarketplace({ open, onOpenChange, navigate }: Props) {
  return (
    <MarketplaceCore
      active={open}
      navigate={navigate}
      onOpenChange={onOpenChange}
      open={open}
    />
  );
}

function MarketplaceCore({
  active = true,
  embedded = false,
  navigate,
  onOpenChange,
  open,
}: MarketplaceCoreProps) {
  const [tab, setTab] = useState<CapabilityTab>("mcps");
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [connections, setConnections] = useState<PublicMcpConnection[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "connected">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callbackStatus = useCallbackNotice();
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [setupProvider, setSetupProvider] = useState<OAuthProvider | null>(
    null
  );
  const pendingConnections = useRef(false);
  const pendingUntil = useRef<number | null>(null);
  const requestGeneration = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastSelectedRef = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const initialFocus = useCallback(
    (interaction: string) => interaction === "touch" || searchInput.current,
    []
  );

  const trackPending = useCallback(
    (next: PublicMcpConnection[], restartWindow = false) => {
      const hasPending = next.some(
        (connection) => connection.status === "pending"
      );
      if (hasPending) {
        // A GET after the ten-minute window must not silently extend polling.
        // A new POST starts a fresh consent window explicitly.
        if (restartWindow || pendingUntil.current === null) {
          pendingUntil.current = Date.now() + PENDING_FLOW_MAX_MS;
        }
        pendingConnections.current = Date.now() < pendingUntil.current;
      } else {
        pendingUntil.current = null;
        pendingConnections.current = false;
      }
    },
    []
  );

  const loadMarketplace = useCallback(
    async (silent = false) => {
      const generation = requestGeneration.current + 1;
      requestGeneration.current = generation;
      if (!silent) {
        setLoading(true);
      }
      if (!silent) {
        setError(null);
      }
      try {
        const res = await fetch("/api/mcp");
        if (!res.ok) {
          throw new Error("Couldn't load the MCP marketplace.");
        }
        const data = (await res.json()) as MarketplaceResponse;
        if (generation !== requestGeneration.current) {
          return;
        }
        setCatalog(data.catalog);
        setConnections(data.connections);
        trackPending(data.connections);
      } catch (err: unknown) {
        if (generation !== requestGeneration.current) {
          return;
        }
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't load the MCP marketplace."
        );
      } finally {
        if (!silent && generation === requestGeneration.current) {
          setLoading(false);
        }
      }
    },
    [trackPending]
  );

  useEffect(() => {
    if (!active || tab !== "mcps") {
      return;
    }
    pendingConnections.current = false;
    pendingUntil.current = null;
    queueMicrotask(() => {
      loadMarketplace().catch(() => undefined);
    });

    // OAuth runs in the system browser when Busy Desktop is used. Refresh as
    // soon as the embedded app regains focus so the connected state appears
    // without making the user close and reopen the marketplace.
    const refreshOnReturn = () => {
      if (document.visibilityState !== "hidden") {
        loadMarketplace(true).catch(() => undefined);
      }
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    const poll = window.setInterval(() => {
      if (pendingUntil.current !== null && Date.now() >= pendingUntil.current) {
        pendingConnections.current = false;
      }
      if (document.visibilityState !== "hidden" && pendingConnections.current) {
        loadMarketplace(true).catch(() => undefined);
      }
    }, 3000);
    return () => {
      requestGeneration.current += 1;
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      window.clearInterval(poll);
    };
  }, [active, tab, loadMarketplace]);

  const connectedIds = useMemo(
    () =>
      new Set(
        connections
          .filter((connection) => connection.status === "connected")
          .map((connection) => connection.catalogId)
      ),
    [connections]
  );
  const connectedCount = catalog.filter((entry) =>
    connectedIds.has(entry.id)
  ).length;

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return catalog.filter(
      (entry) =>
        // ponytail: Google Workspace MCP needs Developer Preview enrollment; hidden unless already connected.
        (entry.oauthProvider !== "google" || connectedIds.has(entry.id)) &&
        (filter === "all" || connectedIds.has(entry.id)) &&
        (!needle ||
          `${entry.name} ${entry.description}`
            .toLocaleLowerCase()
            .includes(needle))
    );
  }, [catalog, connectedIds, filter, query]);

  const selectedEntry = useMemo(
    () =>
      selectedId
        ? (catalog.find((entry) => entry.id === selectedId) ?? null)
        : null,
    [catalog, selectedId]
  );

  const selectIntegration = useCallback((id: string) => {
    lastSelectedRef.current = id;
    setSelectedId(id);
  }, []);

  const backToIntegrations = useCallback(() => {
    setSelectedId(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelectedId(null);
        lastSelectedRef.current = null;
      }
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  useLayoutEffect(() => {
    if (!(active && dialogRef.current)) {
      return;
    }
    if (selectedId) {
      dialogRef.current
        .querySelector<HTMLButtonElement>('[data-mcp-back="true"]')
        ?.focus();
      return;
    }
    const restoreId = lastSelectedRef.current;
    if (!restoreId) {
      return;
    }
    const tile = Array.from(
      dialogRef.current.querySelectorAll<HTMLButtonElement>(
        "[data-integration-id]"
      )
    ).find((button) => button.dataset.integrationId === restoreId);
    (tile ?? searchInput.current)?.focus();
    lastSelectedRef.current = null;
  }, [active, selectedId]);

  const connectionsFor = useCallback(
    (catalogId: string) =>
      connections.filter((connection) => connection.catalogId === catalogId),
    [connections]
  );

  const updatePending = useCallback((id: string, isPending: boolean) => {
    setPending((previous) => {
      const next = new Set(previous);
      if (isPending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const providerSaved = useCallback(
    async (details: ProviderSetupDetails) => {
      await loadMarketplace();
      setSetupProvider(null);
      setNotice(
        `${details.provider === "github" ? "GitHub" : "Google"} credentials saved.`
      );
    },
    [loadMarketplace]
  );

  const connect = useCallback(
    async (entry: McpCatalogEntry, targetConnection?: PublicMcpConnection) => {
      if (pending.has(entry.id)) {
        return;
      }
      updatePending(entry.id, true);
      setError(null);
      setNotice(null);
      try {
        const requestBody = {
          catalogId: entry.id,
          ...(targetConnection ? { connectionId: targetConnection.id } : {}),
        };
        const res = await fetch("/api/mcp", {
          body: JSON.stringify(requestBody),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = (await res.json().catch(() => null)) as {
          connection?: PublicMcpConnection;
          connectUrl?: string | null;
          error?: string;
        } | null;
        if (!(res.ok && data?.connection)) {
          throw new Error(data?.error ?? `Couldn't connect ${entry.name}.`);
        }
        const knownConnection = connections.some(
          (connection) => connection.id === data.connection?.id
        );
        const nextConnections = knownConnection
          ? connections.map((connection) =>
              connection.id === data.connection?.id
                ? data.connection
                : connection
            )
          : [...connections, data.connection];
        setConnections(nextConnections);
        trackPending(nextConnections, data.connection.status === "pending");
        if (data.connectUrl) {
          // Open the same-origin connect route in a browser tab. In Busy Desktop,
          // Electron's window-open policy hands this URL to the system browser;
          // that browser then owns the flow cookie and receives the provider's
          // callback. Navigating the embedded window would strand the cookie in
          // Electron when the provider opens externally.
          (
            navigate ??
            ((url: string) => {
              // Electron's embedded window must hand the same-origin route to the
              // system browser. In a regular browser, same-tab navigation keeps the
              // existing Busy session and avoids popup blockers.
              if (navigator.userAgent.includes("Electron/")) {
                window.open(url, "_blank", "noopener,noreferrer");
              } else {
                window.location.assign(url);
              }
            })
          )(data.connectUrl);
          // The pending connection status is persisted on the server; the local
          // action is done once the browser handoff has been attempted. This
          // keeps Disconnect/Reconnect usable after the Desktop window regains
          // focus and refreshes the connection row.
          updatePending(entry.id, false);
        } else {
          setNotice(`${entry.name} is ready for your bots.`);
          updatePending(entry.id, false);
        }
      } catch (err: unknown) {
        updatePending(entry.id, false);
        setError(
          err instanceof Error ? err.message : `Couldn't connect ${entry.name}.`
        );
      }
    },
    [connections, navigate, pending, trackPending, updatePending]
  );

  const disconnect = useCallback(
    async (entry: McpCatalogEntry, connection: PublicMcpConnection) => {
      if (pending.has(entry.id)) {
        return;
      }
      updatePending(entry.id, true);
      setRemoving((previous) => new Set(previous).add(entry.id));
      setError(null);
      try {
        const res = await fetch(
          `/api/mcp/${encodeURIComponent(connection.id)}`,
          {
            method: "DELETE",
          }
        );
        if (!res.ok) {
          throw new Error(`Couldn't disconnect ${entry.name}.`);
        }
        const nextConnections = connections.filter(
          (item) => item.id !== connection.id
        );
        setConnections(nextConnections);
        trackPending(nextConnections);
        setNotice(
          `${entry.name} ${connection.status === "pending" ? "connection canceled" : "removed"}.`
        );
      } catch (err: unknown) {
        setError(
          err instanceof Error
            ? err.message
            : `Couldn't disconnect ${entry.name}.`
        );
      } finally {
        setRemoving((previous) => {
          const next = new Set(previous);
          next.delete(entry.id);
          return next;
        });
        updatePending(entry.id, false);
      }
    },
    [connections, pending, trackPending, updatePending]
  );

  const updateTools = useCallback<ToolUpdate>(
    async (entry, connection, allowedTools) => {
      try {
        const response = await fetch(
          `/api/mcp/${encodeURIComponent(connection.id)}`,
          {
            body: JSON.stringify({ allowedTools }),
            headers: { "Content-Type": "application/json" },
            method: "PATCH",
          }
        );
        const body = (await response.json().catch(() => null)) as {
          connection?: PublicMcpConnection;
          error?: string;
        } | null;
        if (!(response.ok && body?.connection)) {
          throw new Error(body?.error ?? `Couldn't update ${entry.name}.`);
        }
        const nextConnection = body.connection;
        setConnections((current) =>
          current.map((item) =>
            item.id === connection.id ? nextConnection : item
          )
        );
        setNotice(`${entry.name} tools updated.`);
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : `Couldn't update ${entry.name}.`
        );
        throw err;
      }
    },
    []
  );

  const reviewUpdate = useCallback(
    async (entry: McpCatalogEntry, connection: PublicMcpConnection) => {
      try {
        const response = await fetch(
          `/api/mcp/${encodeURIComponent(connection.id)}`,
          { method: "POST" }
        );
        const body = (await response.json().catch(() => null)) as {
          connection?: PublicMcpConnection;
          error?: string;
        } | null;
        if (!(response.ok && body?.connection)) {
          throw new Error(body?.error ?? `Couldn't update ${entry.name}.`);
        }
        const nextConnection = body.connection;
        setConnections((current) =>
          current.map((item) =>
            item.id === connection.id ? nextConnection : item
          )
        );
        setNotice(
          nextConnection.reauthRequired
            ? `${entry.name} changed its authorization. Reconnect it to continue.`
            : `${entry.name} updated.`
        );
      } catch (cause: unknown) {
        setError(
          cause instanceof Error
            ? cause.message
            : `Couldn't update ${entry.name}.`
        );
        throw cause;
      }
    },
    []
  );

  const discoverTools = useCallback<ToolDiscovery>(
    async (entry, connection) => {
      try {
        const response = await fetch(
          `/api/mcp/${encodeURIComponent(connection.id)}`,
          { method: "PUT" }
        );
        const body = (await response.json().catch(() => null)) as {
          connection?: PublicMcpConnection;
          error?: string;
        } | null;
        if (!(response.ok && body?.connection)) {
          throw new Error(
            body?.error ?? `Couldn't discover ${entry.name} tools.`
          );
        }
        const nextConnection = body.connection;
        setConnections((current) =>
          current.map((item) =>
            item.id === connection.id ? nextConnection : item
          )
        );
        setNotice(`${entry.name} tools discovered.`);
      } catch (cause: unknown) {
        setError(
          cause instanceof Error
            ? cause.message
            : `Couldn't discover ${entry.name} tools.`
        );
        throw cause;
      }
    },
    []
  );

  const showAllApps = useCallback(() => {
    setFilter("all");
  }, []);

  const showConnectedApps = useCallback(() => {
    setFilter("connected");
  }, []);

  const clearSearch = useCallback(() => {
    setQuery("");
    searchInput.current?.focus();
  }, []);

  const resetFilters = useCallback(() => {
    setQuery("");
    setFilter("all");
    searchInput.current?.focus();
  }, []);

  const retry = useCallback(() => {
    loadMarketplace().catch(() => undefined);
  }, [loadMarketplace]);

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setQuery(event.target.value);
    },
    []
  );

  const handleSetupOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setSetupProvider(null);
    }
  }, []);

  const mcpContent = (
    <>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <label className="sr-only" htmlFor={searchId}>
            Search MCPs
          </label>
          <Search aria-hidden className={styles.searchIcon} />
          <Input
            className={styles.searchInput}
            id={searchId}
            onChange={handleQueryChange}
            placeholder="Search tools"
            ref={searchInput}
            value={query}
          />
          {query ? (
            <button
              aria-label="Clear search"
              className={styles.clearSearch}
              onClick={clearSearch}
              type="button"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </div>
        <fieldset className={styles.filters}>
          <legend className="sr-only">Filter apps</legend>
          <button
            aria-label="All apps"
            aria-pressed={filter === "all"}
            className={styles.filter}
            onClick={showAllApps}
            type="button"
          >
            All apps{" "}
            <span aria-hidden className={styles.count}>
              {catalog.length}
            </span>
          </button>
          <button
            aria-label="Connected apps"
            aria-pressed={filter === "connected"}
            className={styles.filter}
            onClick={showConnectedApps}
            type="button"
          >
            Connected apps{" "}
            <span aria-hidden className={styles.count}>
              {connectedCount}
            </span>
          </button>
        </fieldset>
      </div>
      <div className={styles.scrollArea}>
        <MarketplaceState
          catalogLength={catalog.length}
          connectionsFor={connectionsFor}
          error={error}
          filter={filter}
          filtered={filtered}
          loading={loading}
          onConnect={connect}
          onReset={resetFilters}
          onRetry={retry}
          onSelect={selectIntegration}
          pending={pending}
          query={query}
        />
      </div>
      <MarketplaceFeedback
        callbackStatus={callbackStatus}
        catalogLength={catalog.length}
        error={error}
        notice={notice}
      />
    </>
  );

  const catalogContent = embedded ? (
    <div className={styles.panel}>{mcpContent}</div>
  ) : (
    <>
      <DialogHeader className={styles.header}>
        <DialogTitle className={styles.title}>Your toolbox</DialogTitle>
        <DialogDescription className={styles.description}>
          Give your bots access to the apps and skills you work with.
        </DialogDescription>
      </DialogHeader>
      <Tabs.Root className={styles.tabs} onValueChange={setTab} value={tab}>
        <Tabs.List aria-label="App capabilities" className={styles.tabList}>
          {capabilityTabs.map(({ value, label, icon: Icon }) => (
            <Tabs.Tab className={styles.tab} key={value} value={value}>
              <Icon aria-hidden />
              {label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel className={styles.panel} value="mcps">
          {mcpContent}
        </Tabs.Panel>
        <Tabs.Panel
          className="flex min-h-0 flex-1 flex-col outline-none data-hidden:hidden"
          keepMounted
          value="skills"
        >
          <Activity mode={active && tab === "skills" ? "visible" : "hidden"}>
            <CapabilitiesPanel kind="skill" />
          </Activity>
        </Tabs.Panel>
        <Tabs.Panel
          className="flex min-h-0 flex-1 flex-col outline-none data-hidden:hidden"
          keepMounted
          value="plugins"
        >
          <Activity mode={active && tab === "plugins" ? "visible" : "hidden"}>
            <CapabilitiesPanel kind="plugin" />
          </Activity>
        </Tabs.Panel>
      </Tabs.Root>
    </>
  );

  const detailContent = selectedEntry ? (
    <>
      {embedded ? (
        <div className={styles.detailHeader}>
          <Button
            aria-label="Back to integrations"
            className={styles.backButton}
            data-mcp-back="true"
            onClick={backToIntegrations}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft aria-hidden />
            <span>Integrations</span>
          </Button>
          <h3 className="sr-only">{selectedEntry.name} integration</h3>
          <p className="sr-only">
            Manage the {selectedEntry.name} integration for your bots.
          </p>
        </div>
      ) : (
        <DialogHeader className={styles.detailHeader}>
          <Button
            aria-label="Back to integrations"
            className={styles.backButton}
            data-mcp-back="true"
            onClick={backToIntegrations}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft aria-hidden />
            <span>Integrations</span>
          </Button>
          <DialogTitle className="sr-only">
            {selectedEntry.name} integration
          </DialogTitle>
          <DialogDescription className="sr-only">
            Manage the {selectedEntry.name} integration for your bots.
          </DialogDescription>
        </DialogHeader>
      )}
      <McpIntegrationDetails
        busy={pending.has(selectedEntry.id)}
        connections={connectionsFor(selectedEntry.id)}
        entry={selectedEntry}
        onConnect={connect}
        onDisconnect={disconnect}
        onDiscoverTools={discoverTools}
        onReviewUpdate={reviewUpdate}
        onSetup={setSetupProvider}
        onToolsChanged={updateTools}
        removing={removing.has(selectedEntry.id)}
      />
      <MarketplaceFeedback
        callbackStatus={callbackStatus}
        catalogLength={catalog.length}
        error={error}
        notice={notice}
      />
    </>
  ) : null;

  const content = (
    <>
      <Activity mode={selectedEntry ? "visible" : "hidden"}>
        {detailContent}
      </Activity>
      <Activity mode={selectedEntry ? "hidden" : "visible"}>
        {catalogContent}
      </Activity>
    </>
  );

  return (
    <>
      {embedded ? (
        <div className={styles.embeddedShell} ref={dialogRef}>
          {content}
        </div>
      ) : (
        <Dialog onOpenChange={handleOpenChange} open={open}>
          <DialogContent
            className={styles.dialog}
            initialFocus={initialFocus}
            ref={dialogRef}
          >
            {content}
          </DialogContent>
        </Dialog>
      )}
      <McpProviderSetup
        onOpenChange={handleSetupOpenChange}
        onSaved={providerSaved}
        open={setupProvider !== null}
        provider={setupProvider}
      />
    </>
  );
}

export function McpMarketplaceContent({
  active = true,
}: McpMarketplaceContentProps) {
  return <MarketplaceCore active={active} embedded open={active} />;
}
