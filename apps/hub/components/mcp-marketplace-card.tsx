import {
  AlertCircle,
  Check,
  LoaderCircle,
  Settings2,
  Unplug,
} from "lucide-react";
import Image from "next/image";
import { useCallback } from "react";
import type {
  McpCatalogEntry,
  McpConnect,
  PublicMcpConnection,
} from "@/components/mcp-marketplace";
import styles from "@/components/mcp-marketplace.module.css";
import type { OAuthProvider } from "@/components/mcp-provider-setup";
import { Button } from "@/components/ui/button";

interface Props {
  busy: boolean;
  connections: PublicMcpConnection[];
  entry: McpCatalogEntry;
  onConnect: McpConnect;
  onDisconnect: (
    entry: McpCatalogEntry,
    connection: PublicMcpConnection
  ) => Promise<void>;
  onSetup: (provider: OAuthProvider) => void;
  removing: boolean;
}

function primaryConnection(
  connections: PublicMcpConnection[]
): PublicMcpConnection | undefined {
  return (
    connections.find((item) => item.status === "connected") ??
    connections.find((item) => item.status === "pending") ??
    connections[0]
  );
}

function connectLabel(
  entry: McpCatalogEntry,
  busy: boolean,
  failed: boolean,
  waiting: boolean,
  removing: boolean
): string {
  if (busy && !removing) {
    return "Connecting…";
  }
  if (failed) {
    return "Reconnect";
  }
  if (waiting) {
    return "Continue sign-in";
  }
  if (entry.auth === "oauth") {
    return "Connect with OAuth";
  }
  return "Add";
}

function disconnectedStateLabel(
  entry: McpCatalogEntry,
  failed: boolean,
  waiting: boolean
): string {
  if (failed) {
    return "Needs attention";
  }
  if (waiting) {
    return "Waiting for sign-in…";
  }
  if (entry.auth === "oauth") {
    return "Sign-in required";
  }
  return "No sign-in needed";
}

function connectionStatusLabel(status: PublicMcpConnection["status"]): string {
  if (status === "connected") {
    return "Connected";
  }
  if (status === "pending") {
    return "Waiting for sign-in";
  }
  return "Connection needs attention";
}

function connectButtonLabel(label: string): string {
  if (label === "Connect with OAuth") {
    return "Connect";
  }
  return label;
}

function disconnectActionLabel(removing: boolean, waiting: boolean): string {
  if (removing) {
    return "Removing…";
  }
  if (waiting) {
    return "Cancel";
  }
  return "Remove";
}

function reconnectActionLabel(connection: PublicMcpConnection): string | null {
  if (connection.status === "pending") {
    return "Continue sign-in";
  }
  if (connection.status === "error" || connection.reauthRequired) {
    return "Reconnect";
  }
  return null;
}

function SetupButton({
  entry,
  onSetup,
}: {
  entry: McpCatalogEntry;
  onSetup: (provider: OAuthProvider) => void;
}) {
  const handleSetup = useCallback(() => {
    if (entry.oauthProvider) {
      onSetup(entry.oauthProvider);
    }
  }, [entry.oauthProvider, onSetup]);

  return (
    <Button
      className={styles.action}
      onClick={handleSetup}
      size="sm"
      variant="outline"
    >
      <Settings2 aria-hidden />
      Set up {entry.oauthProvider === "github" ? "GitHub" : "Google"}
    </Button>
  );
}

function StatusIcon({
  removing,
  showUnplug,
}: {
  removing: boolean;
  showUnplug: boolean;
}) {
  if (removing) {
    return <LoaderCircle aria-hidden className="animate-spin" />;
  }
  if (showUnplug) {
    return <Unplug aria-hidden />;
  }
  return null;
}

function ConnectIcon({ busy, removing }: { busy: boolean; removing: boolean }) {
  if (busy && !removing) {
    return <LoaderCircle aria-hidden className="animate-spin" />;
  }
  return null;
}

function SetupFooter({
  entry,
  onSetup,
}: {
  entry: McpCatalogEntry;
  onSetup: (provider: OAuthProvider) => void;
}) {
  return (
    <>
      <SetupButton entry={entry} onSetup={onSetup} />
      <Button
        aria-disabled="true"
        aria-label="Connect with OAuth"
        className={styles.action}
        disabled
        size="sm"
        variant="outline"
      >
        Connect
      </Button>
      <span className={styles.state}>Add credentials before connecting.</span>
    </>
  );
}

function ConnectedFooter({
  busy,
  connection,
  entry,
  onDisconnect,
  removing,
}: {
  busy: boolean;
  connection: PublicMcpConnection;
  entry: McpCatalogEntry;
  onDisconnect: Props["onDisconnect"];
  removing: boolean;
}) {
  const handleDisconnect = useCallback(
    () => onDisconnect(entry, connection),
    [connection, entry, onDisconnect]
  );

  return (
    <Button
      className={styles.action}
      disabled={busy}
      onClick={handleDisconnect}
      size="sm"
      variant="ghost"
    >
      <StatusIcon removing={removing} showUnplug />
      {removing ? "Disconnecting…" : "Disconnect"}
    </Button>
  );
}

function DisconnectedFooter({
  busy,
  connection,
  entry,
  failed,
  onConnect,
  onDisconnect,
  removing,
  waiting,
}: {
  busy: boolean;
  connection: PublicMcpConnection | undefined;
  entry: McpCatalogEntry;
  failed: boolean;
  onConnect: Props["onConnect"];
  onDisconnect: Props["onDisconnect"];
  removing: boolean;
  waiting: boolean;
}) {
  const actionLabel = connectLabel(entry, busy, failed, waiting, removing);
  const buttonLabel = connectButtonLabel(actionLabel);
  const stateLabel = disconnectedStateLabel(entry, failed, waiting);
  const stateClass = failed || waiting ? styles.state : "sr-only";
  const showDisconnect = Boolean(connection && (waiting || failed));
  const removeLabel = disconnectActionLabel(removing, waiting);
  const handleConnect = useCallback(
    () => onConnect(entry, connection),
    [connection, entry, onConnect]
  );
  const handleDisconnect = useCallback(() => {
    if (connection) {
      return onDisconnect(entry, connection);
    }
    return Promise.resolve();
  }, [connection, entry, onDisconnect]);

  return (
    <>
      <span className={stateClass}>
        {failed ? <AlertCircle aria-hidden /> : null}
        {stateLabel}
      </span>
      <div className={styles.actions}>
        {showDisconnect ? (
          <Button
            className={styles.action}
            disabled={busy}
            onClick={handleDisconnect}
            size="sm"
            variant="ghost"
          >
            <StatusIcon removing={removing} showUnplug={false} />
            {removeLabel}
          </Button>
        ) : null}
        <Button
          aria-label={actionLabel}
          className={styles.action}
          disabled={busy}
          onClick={handleConnect}
          size="sm"
          variant="ghost"
        >
          <ConnectIcon busy={busy} removing={removing} />
          {buttonLabel}
        </Button>
      </div>
    </>
  );
}

function CardFooter({
  busy,
  connection,
  connected,
  entry,
  failed,
  needsSetup,
  onConnect,
  onDisconnect,
  onSetup,
  removing,
  waiting,
}: {
  busy: boolean;
  connection: PublicMcpConnection | undefined;
  connected: boolean;
  entry: McpCatalogEntry;
  failed: boolean;
  needsSetup: boolean;
  onConnect: Props["onConnect"];
  onDisconnect: Props["onDisconnect"];
  onSetup: Props["onSetup"];
  removing: boolean;
  waiting: boolean;
}) {
  if (needsSetup) {
    return <SetupFooter entry={entry} onSetup={onSetup} />;
  }
  if (connected && connection) {
    return (
      <ConnectedFooter
        busy={busy}
        connection={connection}
        entry={entry}
        onDisconnect={onDisconnect}
        removing={removing}
      />
    );
  }
  return (
    <DisconnectedFooter
      busy={busy}
      connection={connection}
      entry={entry}
      failed={failed}
      onConnect={onConnect}
      onDisconnect={onDisconnect}
      removing={removing}
      waiting={waiting}
    />
  );
}

function DuplicateConnection({
  busy,
  connection,
  entry,
  index,
  onConnect,
  onDisconnect,
  removing,
}: {
  busy: boolean;
  connection: PublicMcpConnection;
  entry: McpCatalogEntry;
  index: number;
  onConnect: Props["onConnect"];
  onDisconnect: Props["onDisconnect"];
  removing: boolean;
}) {
  const reconnectLabel = reconnectActionLabel(connection);
  const handleConnect = useCallback(
    () => onConnect(entry, connection),
    [connection, entry, onConnect]
  );
  const handleDisconnect = useCallback(
    () => onDisconnect(entry, connection),
    [connection, entry, onDisconnect]
  );

  return (
    <div className={styles.duplicateRow}>
      <span>{connectionStatusLabel(connection.status)}</span>
      {reconnectLabel ? (
        <Button
          aria-label={`${reconnectLabel} ${entry.name} connection ${index + 2}`}
          className={styles.action}
          disabled={busy}
          onClick={handleConnect}
          size="sm"
          variant="ghost"
        >
          {reconnectLabel}
        </Button>
      ) : null}
      <Button
        aria-label={`Disconnect ${entry.name} connection ${index + 2}`}
        className={styles.action}
        disabled={busy}
        onClick={handleDisconnect}
        size="sm"
        variant="ghost"
      >
        <StatusIcon removing={removing} showUnplug />
        {removing ? "Removing…" : "Disconnect"}
      </Button>
    </div>
  );
}

function DuplicateConnections({
  busy,
  connections,
  entry,
  onConnect,
  onDisconnect,
  removing,
}: {
  busy: boolean;
  connections: PublicMcpConnection[];
  entry: McpCatalogEntry;
  onConnect: Props["onConnect"];
  onDisconnect: Props["onDisconnect"];
  removing: boolean;
}) {
  return (
    <div className={styles.duplicates}>
      <p>Additional app connections</p>
      {connections.map((duplicate, index) => (
        <DuplicateConnection
          busy={busy}
          connection={duplicate}
          entry={entry}
          index={index}
          key={duplicate.id}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          removing={removing}
        />
      ))}
    </div>
  );
}

export function McpIntegrationActions({
  busy,
  connections,
  entry,
  onConnect,
  onDisconnect,
  onSetup,
  removing,
}: Props) {
  const connection = primaryConnection(connections);
  const duplicates = connections.filter((item) => item.id !== connection?.id);
  const connected = connection?.status === "connected";
  const failed = connection?.status === "error";
  const waiting = connection?.status === "pending";
  const needsSetup = Boolean(entry.oauthProvider && entry.configured === false);

  return (
    <div className={styles.integrationActions}>
      <div className={styles.cardFooter}>
        <CardFooter
          busy={busy}
          connected={connected}
          connection={connection}
          entry={entry}
          failed={failed}
          needsSetup={needsSetup}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onSetup={onSetup}
          removing={removing}
          waiting={waiting}
        />
      </div>
      {duplicates.length > 0 ? (
        <DuplicateConnections
          busy={busy}
          connections={duplicates}
          entry={entry}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          removing={removing}
        />
      ) : null}
    </div>
  );
}

interface TileProps {
  busy: boolean;
  connections: PublicMcpConnection[];
  entry: McpCatalogEntry;
  onConnect: Props["onConnect"];
  onSelect: (id: string) => void;
}

export function McpMarketplaceCard({
  busy,
  connections,
  entry,
  onConnect,
  onSelect,
}: TileProps) {
  const connection = primaryConnection(connections);
  const connected = connection?.status === "connected";
  const failed = connection?.status === "error";
  const waiting = connection?.status === "pending";
  const needsSetup = Boolean(entry.oauthProvider && entry.configured === false);
  const label = connectLabel(entry, busy, failed, waiting, false);
  const actionLabel = needsSetup
    ? `Set up ${entry.oauthProvider === "github" ? "GitHub" : "Google"}`
    : label;
  const visibleLabel = needsSetup ? "Set up" : connectButtonLabel(label);

  const openDetails = useCallback(
    () => onSelect(entry.id),
    [entry.id, onSelect]
  );
  const connect = useCallback(() => {
    if (needsSetup) {
      onSelect(entry.id);
      return Promise.resolve();
    }
    return onConnect(entry, connection);
  }, [connection, entry, needsSetup, onConnect, onSelect]);

  return (
    <li className={styles.card}>
      <button
        aria-label={`View ${entry.name} details`}
        className={styles.integrationOpen}
        data-integration-id={entry.id}
        onClick={openDetails}
        type="button"
      >
        <span className={styles.appIcon}>
          <Image alt="" height={32} src={entry.icon} unoptimized width={32} />
        </span>
        <span className={styles.appName}>{entry.name}</span>
        {connected ? (
          <span className={styles.tileConnected}>
            <Check aria-hidden />
            Connected
          </span>
        ) : null}
      </button>
      {connected ? null : (
        <div className={styles.tileAction}>
          <Button
            aria-label={actionLabel}
            className={styles.tileConnect}
            disabled={busy}
            onClick={connect}
            size="sm"
            variant="secondary"
          >
            {busy ? (
              <LoaderCircle aria-hidden className="animate-spin" />
            ) : null}
            {visibleLabel}
          </Button>
        </div>
      )}
    </li>
  );
}
