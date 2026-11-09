"use client";

import { Check, GitBranch, Loader2, RefreshCw, Search, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatItem } from "@/lib/chat/items";

type SetupInteraction = Extract<ChatItem, { kind: "interaction" }>;

interface CodeTaskConnection {
  catalogId?: string;
  enabled?: boolean;
  id: string;
  label: string;
  status?: string;
}

interface CodeRepository {
  connectionId: string | null;
  defaultBranch: string;
  enabled: boolean;
  fullName: string;
  id: string;
}

interface CodeTaskMetadata {
  activeRepositoryId?: string | null;
  connections?: CodeTaskConnection[];
  repositories?: CodeRepository[];
}

interface RepositoryDiscovery {
  defaultBranch: string;
  fullName: string;
  githubId: string;
  private: boolean;
}

interface DiscoveryResponse {
  nextPage?: string | number | null;
  repositories?: RepositoryDiscovery[];
}

interface DiscoveryState {
  connectionId: string | null;
  error: string | null;
  nextPage: string | number | null;
  repositories: RepositoryDiscovery[];
}

interface ConnectResponse {
  code?: unknown;
  connection?: {
    catalogId?: unknown;
    id?: unknown;
  };
  connectUrl?: unknown;
  error?: unknown;
}

const EMPTY_DISCOVERY: DiscoveryState = {
  connectionId: null,
  error: null,
  nextPage: null,
  repositories: [],
};

type Answer = (value: { optionId?: string; text?: string }) => Promise<boolean>;

interface Props {
  answer: Answer;
  botSlug: string;
  item: SetupInteraction;
  pending: boolean;
  state: string;
}

function safeError(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return null;
}

/** Opens only Busy's same-origin OAuth handoff; provider tokens never enter this card. */
export function openMcpConnectUrl(
  connectUrl: string,
  returnTo?: string
): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const url = new URL(connectUrl, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/api/mcp/")
    ) {
      return false;
    }
    if (returnTo) {
      if (!returnTo.startsWith("/b/") || returnTo.includes("?")) {
        return false;
      }
      url.searchParams.set("returnTo", returnTo);
    }
    if (navigator.userAgent.includes("Electron/")) {
      window.open(url.href, "_blank", "noopener,noreferrer");
      return true;
    }
    window.location.assign(url.href);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(safeError(body) ?? "The request could not be completed.");
  }
  return body as T;
}

async function selectRepository(
  botSlug: string,
  repositoryId: string
): Promise<void> {
  const response = await fetch(
    `/api/bots/${encodeURIComponent(botSlug)}/code-repository`,
    {
      body: JSON.stringify({ repositoryId }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    }
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      safeError(body) ?? "Couldn't select this repository. Try again."
    );
  }
}

async function discoverRepositories(
  connectionId: string,
  page?: string | number | null,
  signal?: AbortSignal
): Promise<DiscoveryResponse> {
  const queryParams = new URLSearchParams({
    connectionId,
    ...(page === undefined || page === null ? {} : { page: String(page) }),
  });
  return await readJson<DiscoveryResponse>(
    `/api/code-repositories/github?${queryParams.toString()}`,
    signal
  );
}

function mergeDiscovered(
  current: RepositoryDiscovery[],
  incoming: RepositoryDiscovery[]
) {
  const merged = new Map(
    current.map((repository) => [repository.fullName, repository])
  );
  for (const repository of incoming) {
    merged.set(repository.fullName, repository);
  }
  return [...merged.values()];
}

function metadataRepositories(metadata: CodeTaskMetadata | null) {
  return metadata?.repositories ?? [];
}

function validConnections(connections: CodeTaskConnection[] | undefined) {
  return (connections ?? []).filter(
    (connection) =>
      connection.id.trim() &&
      connection.enabled !== false &&
      (!connection.catalogId || connection.catalogId === "github") &&
      (!connection.status || connection.status === "connected")
  );
}

function discoveryErrorText(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return "";
  }
  return cause instanceof Error
    ? cause.message
    : "Couldn't list GitHub repositories.";
}

async function fetchInitialDiscovery(
  connectionId: string,
  signal: AbortSignal
): Promise<{ body: DiscoveryResponse } | { error: string }> {
  try {
    return {
      body: await discoverRepositories(connectionId, null, signal),
    };
  } catch (cause) {
    return { error: discoveryErrorText(cause) };
  }
}

async function requestGithubConnection(connectionId?: string | null): Promise<{
  body: ConnectResponse | null;
  ok: boolean;
}> {
  const response = await fetch(
    connectionId
      ? `/api/mcp/${encodeURIComponent(connectionId)}/connect`
      : "/api/mcp",
    connectionId
      ? { method: "POST" }
      : {
          body: JSON.stringify({ catalogId: "github" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }
  );
  const body = (await response
    .json()
    .catch(() => null)) as ConnectResponse | null;
  return { body, ok: response.ok };
}

function returnedGithubConnectionId(
  body: ConnectResponse | null
): string | null {
  const connection = body?.connection;
  if (
    connection?.catalogId === "github" &&
    typeof connection.id === "string" &&
    connection.id
  ) {
    return connection.id;
  }
  return null;
}

function githubConnectionError(body: ConnectResponse | null): Error {
  const message = safeError(body);
  if (
    body?.code === "provider_setup_required" ||
    message?.toLocaleLowerCase().includes("set up github")
  ) {
    return new Error(
      "GitHub sign-in is not available yet. An administrator must configure it in Skills and plugins."
    );
  }
  return new Error("Couldn't start GitHub sign-in. Try again.");
}

async function beginGithubConnection(
  connectionId: string | null,
  botSlug: string
): Promise<void> {
  let result = await requestGithubConnection(connectionId);
  if (!result.ok) {
    throw githubConnectionError(result.body);
  }
  if (typeof result.body?.connectUrl !== "string" && !connectionId) {
    const returnedConnectionId = returnedGithubConnectionId(result.body);
    if (returnedConnectionId) {
      result = await requestGithubConnection(returnedConnectionId);
    }
  }
  if (!result.ok) {
    throw githubConnectionError(result.body);
  }
  if (
    typeof result.body?.connectUrl !== "string" ||
    !openMcpConnectUrl(result.body.connectUrl, `/b/${botSlug}`)
  ) {
    throw new Error("Busy returned an invalid GitHub sign-in link.");
  }
}

export function CodeRepositorySetupCard({
  answer,
  botSlug,
  item,
  pending,
  state,
}: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [metadata, setMetadata] = useState<CodeTaskMetadata | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(null);
  const [discovery, setDiscovery] = useState<DiscoveryState>(EMPTY_DISCOVERY);
  const [query, setQuery] = useState("");
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [loadingRepositoriesFor, setLoadingRepositoriesFor] = useState<
    string | null
  >(null);
  const [working, setWorking] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callbackErrorDismissed, setCallbackErrorDismissed] = useState(false);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const connectionIdRef = useRef<string | null>(null);
  const active = state === "open" && !pending && !locked;
  const callbackError =
    active &&
    !callbackErrorDismissed &&
    pathname === `/b/${encodeURIComponent(botSlug)}` &&
    searchParams.get("codeSetup") === "error"
      ? "GitHub sign-in did not finish. Connect GitHub to try again."
      : null;
  const showLoading = active && loading;
  const connections = useMemo(() => metadata?.connections ?? [], [metadata]);
  const connectionId = connections.some(
    (connection) => connection.id === selectedConnectionId
  )
    ? selectedConnectionId
    : (connections[0]?.id ?? null);
  const discoveryReady =
    connectionId !== null && discovery.connectionId === connectionId;
  const discovered = useMemo(
    () =>
      discoveryReady ? discovery.repositories : EMPTY_DISCOVERY.repositories,
    [discovery, discoveryReady]
  );
  const nextPage = discoveryReady ? discovery.nextPage : null;
  const discoveryError = discoveryReady ? discovery.error : null;
  const loadingRepositories = loadingRepositoriesFor === connectionId;
  const discoveryLoading = active && connectionId !== null && !discoveryReady;

  useEffect(() => {
    connectionIdRef.current = connectionId;
  }, [connectionId]);

  const loadMetadata = useCallback(
    async (signal?: AbortSignal) => {
      const body = await readJson<CodeTaskMetadata>(
        `/api/bots/${encodeURIComponent(botSlug)}/code-repository`,
        signal
      );
      const normalized = {
        ...body,
        connections: validConnections(body.connections),
      };
      const requestedConnectionId = connectionIdRef.current;
      const nextConnectionId = normalized.connections.some(
        (connection) => connection.id === requestedConnectionId
      )
        ? requestedConnectionId
        : (normalized.connections[0]?.id ?? null);
      connectionIdRef.current = nextConnectionId;
      setMetadata(normalized);
      if (!normalized.connections.length) {
        discoveryAbortRef.current?.abort();
        setDiscovery(EMPTY_DISCOVERY);
        setLoadingRepositoriesFor(null);
      }
      setSelectedConnectionId((current) =>
        current === nextConnectionId ? current : nextConnectionId
      );
      setSelectedRepositoryId((current) => {
        const currentRepository = normalized.repositories?.find(
          (repository) => repository.id === current
        );
        if (currentRepository?.connectionId === nextConnectionId) {
          return current;
        }
        return (
          normalized.repositories?.find(
            (repository) =>
              repository.id === normalized.activeRepositoryId &&
              repository.connectionId === nextConnectionId
          )?.id ?? null
        );
      });
      setError(null);
    },
    [botSlug]
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    const controller = new AbortController();
    let alive = true;
    const refresh = () => {
      loadMetadata(controller.signal)
        .catch((cause: unknown) => {
          if (
            alive &&
            !(cause instanceof DOMException && cause.name === "AbortError")
          ) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Couldn't load GitHub setup."
            );
          }
        })
        .finally(() => {
          if (alive) {
            setLoading(false);
          }
        });
    };
    const onFocus = () => {
      if (document.visibilityState !== "hidden") {
        refresh();
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [active, loadMetadata]);

  useEffect(() => {
    if (!(active && connectionId)) {
      return;
    }
    discoveryAbortRef.current?.abort();
    const controller = new AbortController();
    discoveryAbortRef.current = controller;
    let alive = true;
    const refresh = async () => {
      const result = await fetchInitialDiscovery(
        connectionId,
        controller.signal
      );
      if (!alive || connectionIdRef.current !== connectionId) {
        return;
      }
      if ("error" in result) {
        if (result.error) {
          setDiscovery({
            connectionId,
            error: result.error,
            nextPage: null,
            repositories: [],
          });
        }
        return;
      }
      setDiscovery({
        connectionId,
        error: null,
        nextPage: result.body.nextPage ?? null,
        repositories: result.body.repositories ?? [],
      });
    };
    const cleanup = () => {
      if (discoveryAbortRef.current === controller) {
        discoveryAbortRef.current = null;
      }
    };
    refresh().finally(cleanup);
    return () => {
      alive = false;
      controller.abort();
      if (discoveryAbortRef.current === controller) {
        discoveryAbortRef.current = null;
      }
    };
  }, [active, connectionId]);

  const loadRepositories = useCallback(
    async (page?: string | number | null) => {
      if (!connectionId) {
        return;
      }
      discoveryAbortRef.current?.abort();
      const controller = new AbortController();
      discoveryAbortRef.current = controller;
      setLoadingRepositoriesFor(connectionId);
      try {
        const body = await discoverRepositories(
          connectionId,
          page,
          controller.signal
        );
        if (connectionIdRef.current !== connectionId) {
          return;
        }
        setDiscovery((current) => ({
          connectionId,
          error: null,
          nextPage: body.nextPage ?? null,
          repositories:
            page === undefined || page === null
              ? (body.repositories ?? [])
              : mergeDiscovered(current.repositories, body.repositories ?? []),
        }));
        setError(null);
      } catch (cause) {
        const message = discoveryErrorText(cause);
        if (message && connectionIdRef.current === connectionId) {
          setDiscovery((current) => ({
            connectionId,
            error: message,
            nextPage: current.nextPage,
            repositories: current.repositories,
          }));
        }
      } finally {
        if (discoveryAbortRef.current === controller) {
          discoveryAbortRef.current = null;
          setLoadingRepositoriesFor(null);
        }
      }
    },
    [connectionId]
  );

  const repositories = useMemo(() => {
    const merged = new Map<string, CodeRepository | RepositoryDiscovery>();
    const validConnectionIds = new Set(
      connections.map((connection) => connection.id)
    );
    for (const repository of metadataRepositories(metadata)) {
      if (
        !(
          repository.enabled &&
          repository.connectionId &&
          repository.connectionId === connectionId &&
          validConnectionIds.has(repository.connectionId)
        )
      ) {
        continue;
      }
      merged.set(repository.fullName, repository);
    }
    for (const repository of discovered) {
      if (!merged.has(repository.fullName)) {
        merged.set(repository.fullName, repository);
      }
    }
    const needle = query.trim().toLocaleLowerCase();
    return [...merged.values()].filter(
      (repository) =>
        !needle || repository.fullName.toLocaleLowerCase().includes(needle)
    );
  }, [connectionId, connections, discovered, metadata, query]);

  const selectedRepository = repositories.find(
    (repository) => "id" in repository && repository.id === selectedRepositoryId
  );

  const addRepository = useCallback(
    async (repository: RepositoryDiscovery) => {
      if (!connectionId) {
        return;
      }
      setWorking(true);
      setError(null);
      try {
        const response = await fetch("/api/code-repositories", {
          body: JSON.stringify({
            connectionId,
            fullName: repository.fullName,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const body = (await response.json().catch(() => null)) as {
          repository?: CodeRepository;
          error?: unknown;
        } | null;
        if (!(response.ok && body?.repository)) {
          throw new Error(safeError(body) ?? "Couldn't add this repository.");
        }
        const addedRepository = body.repository;
        setMetadata((current) => ({
          ...(current ?? {}),
          repositories: [
            ...(current?.repositories ?? []).filter(
              (currentRepository) => currentRepository.id !== addedRepository.id
            ),
            addedRepository,
          ],
        }));
        setSelectedRepositoryId(addedRepository.id);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn't add this repository."
        );
      } finally {
        setWorking(false);
      }
    },
    [connectionId]
  );

  const chooseRepository = useCallback(
    async (repository: CodeRepository | RepositoryDiscovery) => {
      if ("id" in repository) {
        setSelectedRepositoryId(repository.id);
        return;
      }
      await addRepository(repository);
    },
    [addRepository]
  );

  const connectGithub = useCallback(async () => {
    setWorking(true);
    setError(null);
    setCallbackErrorDismissed(true);
    const url = new URL(window.location.href);
    if (url.pathname === `/b/${encodeURIComponent(botSlug)}`) {
      url.searchParams.delete("codeSetup");
      window.history.replaceState(window.history.state, "", url);
    }
    try {
      await beginGithubConnection(connectionId, botSlug);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Couldn't connect GitHub."
      );
    } finally {
      setWorking(false);
    }
  }, [botSlug, connectionId]);

  const submit = useCallback(async () => {
    if (!(selectedRepositoryId && !working && !pending && !locked)) {
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await selectRepository(botSlug, selectedRepositoryId);
      if (await answer({ text: selectedRepositoryId })) {
        setLocked(true);
      } else {
        setError("Couldn't send the repository. Try again.");
      }
    } catch {
      setError("Couldn't send the repository. Try again.");
    } finally {
      setWorking(false);
    }
  }, [answer, botSlug, locked, pending, selectedRepositoryId, working]);

  const cancel = useCallback(async () => {
    if (working || pending || locked) {
      return;
    }
    setWorking(true);
    setError(null);
    try {
      if (await answer({ optionId: "cancel" })) {
        setLocked(true);
      } else {
        setError("Couldn't cancel setup. Try again.");
      }
    } catch {
      setError("Couldn't cancel setup. Try again.");
    } finally {
      setWorking(false);
    }
  }, [answer, locked, pending, working]);

  const handleQueryChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(event.target.value);
    },
    []
  );
  const handleConnectionChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      discoveryAbortRef.current?.abort();
      const nextConnectionId = event.target.value || null;
      connectionIdRef.current = nextConnectionId;
      setSelectedConnectionId(nextConnectionId);
      setSelectedRepositoryId(null);
      setDiscovery(EMPTY_DISCOVERY);
      setLoadingRepositoriesFor(null);
      setQuery("");
    },
    []
  );
  const refreshRepositories = useCallback(
    () => loadRepositories(),
    [loadRepositories]
  );
  const loadNextPage = useCallback(
    () => loadRepositories(nextPage),
    [loadRepositories, nextPage]
  );
  const handleRepositoryClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const { fullName } = event.currentTarget.dataset;
      const repository = repositories.find(
        (candidate) => candidate.fullName === fullName
      );
      if (repository) {
        chooseRepository(repository).catch(() => undefined);
      }
    },
    [chooseRepository, repositories]
  );

  return (
    <CodeRepositorySetupView
      active={active}
      cancel={cancel}
      connectGithub={connectGithub}
      connectionId={connectionId}
      connections={connections}
      discoveryError={discoveryError}
      discoveryLoading={discoveryLoading}
      error={error ?? callbackError}
      handleConnectionChange={handleConnectionChange}
      handleQueryChange={handleQueryChange}
      handleRepositoryClick={handleRepositoryClick}
      item={item}
      loadingRepositories={loadingRepositories}
      loadNextPage={loadNextPage}
      locked={locked}
      nextPage={nextPage}
      pending={pending}
      query={query}
      refreshRepositories={refreshRepositories}
      repositories={repositories}
      selectedRepository={selectedRepository}
      selectedRepositoryId={selectedRepositoryId}
      showLoading={showLoading}
      submit={submit}
      working={working}
    />
  );
}

function CodeRepositorySetupView({
  active,
  connectionId,
  connectGithub,
  connections,
  discoveryError,
  discoveryLoading,
  error,
  handleConnectionChange,
  handleQueryChange,
  handleRepositoryClick,
  item,
  loadNextPage,
  loadingRepositories,
  locked,
  nextPage,
  pending,
  query,
  refreshRepositories,
  repositories,
  selectedRepository,
  selectedRepositoryId,
  showLoading,
  submit,
  cancel,
  working,
}: {
  active: boolean;
  connectionId: string | null;
  connectGithub: () => Promise<void>;
  connections: CodeTaskConnection[];
  discoveryError: string | null;
  discoveryLoading: boolean;
  error: string | null;
  handleConnectionChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  handleQueryChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleRepositoryClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  item: SetupInteraction;
  loadNextPage: () => Promise<void>;
  loadingRepositories: boolean;
  locked: boolean;
  nextPage: string | number | null;
  pending: boolean;
  query: string;
  refreshRepositories: () => Promise<void>;
  repositories: (CodeRepository | RepositoryDiscovery)[];
  selectedRepository?: CodeRepository | RepositoryDiscovery;
  selectedRepositoryId: string | null;
  showLoading: boolean;
  submit: () => Promise<void>;
  cancel: () => Promise<void>;
  working: boolean;
}) {
  return (
    <div
      className="flex w-full flex-col gap-3"
      data-interaction-id={item.interactionId}
    >
      {error || discoveryError ? (
        <p className="text-destructive text-[13px]" role="alert">
          {error ?? discoveryError}
        </p>
      ) : null}
      {showLoading ? (
        <p className="text-muted-foreground text-[13px]" role="status">
          Checking GitHub access…
        </p>
      ) : null}
      {active && !showLoading && connections.length > 1 ? (
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">GitHub connection</span>
          <select
            aria-label="GitHub connection"
            className="border-border bg-background rounded-md border px-2.5 py-2"
            onChange={handleConnectionChange}
            value={connectionId ?? ""}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {connectionId ? null : (
        <DisconnectedControls
          active={active}
          cancel={cancel}
          connectGithub={connectGithub}
          locked={locked}
          pending={pending}
          showLoading={showLoading}
          working={working}
        />
      )}
      {active && !showLoading && connectionId ? (
        <ConnectedRepositoryControls
          cancel={cancel}
          connectGithub={connectGithub}
          discoveryError={discoveryError}
          handleQueryChange={handleQueryChange}
          handleRepositoryClick={handleRepositoryClick}
          loadingRepositories={loadingRepositories || discoveryLoading}
          loadNextPage={loadNextPage}
          locked={locked}
          nextPage={nextPage}
          pending={pending}
          query={query}
          refreshRepositories={refreshRepositories}
          repositories={repositories}
          selectedRepository={selectedRepository}
          selectedRepositoryId={selectedRepositoryId}
          submit={submit}
          working={working}
        />
      ) : null}
      {pending || locked ? (
        <p className="text-muted-foreground text-[13px]" role="status">
          Waiting for Busy to continue…
        </p>
      ) : null}
    </div>
  );
}

function DisconnectedControls({
  active,
  cancel,
  connectGithub,
  locked,
  pending,
  showLoading,
  working,
}: {
  active: boolean;
  cancel: () => Promise<void>;
  connectGithub: () => Promise<void>;
  locked: boolean;
  pending: boolean;
  showLoading: boolean;
  working: boolean;
}) {
  if (!active) {
    return null;
  }
  return (
    <div className="flex items-center gap-2">
      {showLoading ? null : (
        <Button
          disabled={working || pending || locked}
          onClick={connectGithub}
          type="button"
        >
          {working ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <GitBranch aria-hidden="true" />
          )}
          Connect GitHub
        </Button>
      )}
      <Button
        disabled={working || pending || locked}
        onClick={cancel}
        type="button"
        variant="ghost"
      >
        <X aria-hidden="true" /> Not now
      </Button>
    </div>
  );
}

function ConnectedRepositoryControls({
  cancel,
  connectGithub,
  discoveryError,
  handleQueryChange,
  handleRepositoryClick,
  loadNextPage,
  loadingRepositories,
  locked,
  nextPage,
  pending,
  query,
  refreshRepositories,
  repositories,
  selectedRepository,
  selectedRepositoryId,
  submit,
  working,
}: {
  cancel: () => Promise<void>;
  connectGithub: () => Promise<void>;
  discoveryError: string | null;
  handleQueryChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleRepositoryClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  loadNextPage: () => Promise<void>;
  loadingRepositories: boolean;
  locked: boolean;
  nextPage: string | number | null;
  pending: boolean;
  query: string;
  refreshRepositories: () => Promise<void>;
  repositories: (CodeRepository | RepositoryDiscovery)[];
  selectedRepository?: CodeRepository | RepositoryDiscovery;
  selectedRepositoryId: string | null;
  submit: () => Promise<void>;
  working: boolean;
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Search aria-hidden="true" className="text-muted-foreground size-4" />
        <Input
          aria-label="Search GitHub repositories"
          onChange={handleQueryChange}
          placeholder="Search repositories"
          value={query}
        />
        <Button
          aria-label="Refresh repositories"
          disabled={loadingRepositories}
          onClick={refreshRepositories}
          size="icon"
          type="button"
          variant="ghost"
        >
          {loadingRepositories ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
        </Button>
      </div>
      {discoveryError ? (
        <Button
          disabled={working || pending || locked}
          onClick={connectGithub}
          type="button"
          variant="outline"
        >
          <GitBranch aria-hidden="true" /> Reconnect GitHub
        </Button>
      ) : null}
      <RepositoryResults
        handleRepositoryClick={handleRepositoryClick}
        loading={loadingRepositories}
        repositories={repositories}
        selectedRepositoryId={selectedRepositoryId}
      />
      {nextPage === null ? null : (
        <Button
          disabled={loadingRepositories}
          onClick={loadNextPage}
          size="sm"
          type="button"
          variant="outline"
        >
          Load more
        </Button>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          disabled={working || pending || locked}
          onClick={cancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" /> Cancel
        </Button>
        <Button
          disabled={working || pending || locked || !selectedRepositoryId}
          onClick={submit}
          size="sm"
          type="button"
        >
          {working ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : null}
          Continue with {selectedRepository?.fullName ?? "repository"}
        </Button>
      </div>
      {selectedRepository ? (
        <p className="text-muted-foreground text-right text-[11px]">
          Selected: {selectedRepository.fullName}
        </p>
      ) : null}
    </>
  );
}

function RepositoryResults({
  handleRepositoryClick,
  loading,
  repositories,
  selectedRepositoryId,
}: {
  handleRepositoryClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  loading: boolean;
  repositories: (CodeRepository | RepositoryDiscovery)[];
  selectedRepositoryId: string | null;
}) {
  if (loading) {
    return (
      <p className="text-muted-foreground text-[13px]" role="status">
        Loading GitHub repositories…
      </p>
    );
  }
  if (!repositories.length) {
    return (
      <p className="text-muted-foreground text-[13px]" role="status">
        No repositories found.
      </p>
    );
  }
  return (
    <div
      aria-label="GitHub repositories"
      className="max-h-48 space-y-1 overflow-y-auto"
      role="listbox"
    >
      {repositories.map((repository) => {
        const id = "id" in repository ? repository.id : null;
        const selected = id !== null && id === selectedRepositoryId;
        return (
          <button
            aria-selected={selected}
            className="hover:bg-muted flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm"
            data-full-name={repository.fullName}
            key={repository.fullName}
            onClick={handleRepositoryClick}
            role="option"
            type="button"
          >
            <span className="truncate">{repository.fullName}</span>
            {selected ? (
              <Check aria-hidden="true" className="size-4 shrink-0" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
