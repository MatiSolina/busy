import { Check, ExternalLink, Globe2, PlugZap, Settings2 } from "lucide-react";
import Image from "next/image";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import styles from "@/components/mcp-integration-details.module.css";
import type {
  McpCatalogEntry,
  McpConnect,
  McpToolDescriptor,
  PublicMcpConnection,
} from "@/components/mcp-marketplace";
import { McpIntegrationActions } from "@/components/mcp-marketplace-card";
import { getMcpCategory } from "@/components/mcp-marketplace-categories";
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
  onDiscoverTools?: (
    entry: McpCatalogEntry,
    connection: PublicMcpConnection
  ) => Promise<void>;
  onReviewUpdate?: (
    entry: McpCatalogEntry,
    connection: PublicMcpConnection
  ) => Promise<void>;
  onSetup: (provider: OAuthProvider) => void;
  onToolsChanged?: (
    entry: McpCatalogEntry,
    connection: PublicMcpConnection,
    allowedTools: string[]
  ) => Promise<void>;
  removing: boolean;
}

function signInLabel(auth: McpCatalogEntry["auth"]) {
  return auth === "oauth" ? "Required" : "Not required";
}

function transportLabel(transport: McpCatalogEntry["transport"]) {
  return transport === "http" ? "Streamable HTTP" : "Server-sent events";
}

function connectionLabel(status: PublicMcpConnection["status"]) {
  if (status === "connected") {
    return "Connected";
  }
  if (status === "pending") {
    return "Waiting for sign-in";
  }
  return "Needs attention";
}

function ConnectionStatus({
  status,
}: {
  status: PublicMcpConnection["status"];
}) {
  return (
    <span
      className={`${styles.connectionStatus} ${status === "connected" ? styles.connected : ""}`}
    >
      {status === "connected" ? <Check aria-hidden /> : <PlugZap aria-hidden />}
      {connectionLabel(status)}
    </span>
  );
}

function ConnectionList({
  connections,
  entry,
  onReviewUpdate,
  onDiscoverTools,
  onToolsChanged,
}: {
  connections: PublicMcpConnection[];
  entry: McpCatalogEntry;
  onDiscoverTools?: Props["onDiscoverTools"];
  onReviewUpdate?: Props["onReviewUpdate"];
  onToolsChanged?: Props["onToolsChanged"];
}) {
  if (connections.length === 0) {
    return (
      <div className={styles.emptyConnections}>
        <PlugZap aria-hidden />
        <p>No connection has been added for this app yet.</p>
      </div>
    );
  }

  return (
    <div className={styles.connectionList}>
      {connections.map((connection, index) => (
        <ConnectionRow
          connection={connection}
          entry={entry}
          index={index}
          key={connection.id}
          onDiscoverTools={onDiscoverTools}
          onReviewUpdate={onReviewUpdate}
          onToolsChanged={onToolsChanged}
          total={connections.length}
        />
      ))}
    </div>
  );
}

function ConnectionRow({
  connection,
  entry,
  index,
  onDiscoverTools,
  onReviewUpdate,
  onToolsChanged,
  total,
}: {
  connection: PublicMcpConnection;
  entry: McpCatalogEntry;
  index: number;
  onReviewUpdate?: Props["onReviewUpdate"];
  onDiscoverTools?: Props["onDiscoverTools"];
  onToolsChanged?: Props["onToolsChanged"];
  total: number;
}) {
  const handleReviewUpdate = useCallback(() => {
    if (onReviewUpdate) {
      onReviewUpdate(entry, connection).catch(() => undefined);
    }
  }, [connection, entry, onReviewUpdate]);

  const handleDiscoverTools = useCallback(() => {
    if (onDiscoverTools) {
      onDiscoverTools(entry, connection).catch(() => undefined);
    }
  }, [connection, entry, onDiscoverTools]);

  return (
    <div className={styles.connectionRow}>
      <div className={styles.connectionMeta}>
        <span className={styles.connectionName}>
          {entry.name} connection
          {total > 1 ? ` ${index + 1}` : ""}
        </span>
        <details className={styles.connectionDetails}>
          <summary>Connection details</summary>
          <code>{connection.id}</code>
        </details>
        {connection.status === "error" && connection.error ? (
          <span className={styles.connectionError}>{connection.error}</span>
        ) : null}
        {connection.lifecycle === "update" ? (
          <span className={styles.connectionError}>
            A reviewed catalog update is available.
          </span>
        ) : null}
      </div>
      <ConnectionStatus status={connection.status} />
      {connection.lifecycle === "update" && onReviewUpdate ? (
        <Button onClick={handleReviewUpdate} size="sm" variant="outline">
          Review update
        </Button>
      ) : null}
      {connection.status === "connected" && onToolsChanged ? (
        <ConnectionTools
          connection={connection}
          entry={entry}
          handleDiscoverTools={handleDiscoverTools}
          onDiscoverTools={onDiscoverTools}
          onToolsChanged={onToolsChanged}
        />
      ) : null}
    </div>
  );
}

function ConnectionTools({
  connection,
  entry,
  handleDiscoverTools,
  onDiscoverTools,
  onToolsChanged,
}: {
  connection: PublicMcpConnection;
  entry: McpCatalogEntry;
  handleDiscoverTools: () => void;
  onDiscoverTools?: Props["onDiscoverTools"];
  onToolsChanged: NonNullable<Props["onToolsChanged"]>;
}) {
  if (connection.tools?.length) {
    return (
      <ToolAllowlist
        connection={connection}
        entry={entry}
        key={`${connection.id}:${(connection.allowedTools ?? []).join(",")}:${(connection.tools ?? []).map((tool) => tool.name).join(",")}`}
        onToolsChanged={onToolsChanged}
      />
    );
  }
  if (onDiscoverTools) {
    return (
      <div className={styles.legacyToolsNotice}>
        {connection.aclMode === "legacy" ? (
          <p>
            This legacy connection keeps the existing approval policy until its
            tools are reviewed.
          </p>
        ) : null}
        <Button onClick={handleDiscoverTools} size="sm" variant="outline">
          Discover tools
        </Button>
      </div>
    );
  }
  return null;
}

function ToolAllowlist({
  connection,
  entry,
  onToolsChanged,
}: {
  connection: PublicMcpConnection;
  entry: McpCatalogEntry;
  onToolsChanged: NonNullable<Props["onToolsChanged"]>;
}) {
  const tools = useMemo(
    () => connection.tools ?? entry.tools ?? [],
    [connection.tools, entry.tools]
  );
  const safeDefaults = useMemo(
    () =>
      tools
        .filter((tool) => tool.readOnlyHint && !tool.destructiveHint)
        .map((tool) => tool.name),
    [tools]
  );
  const [selected, setSelected] = useState(
    connection.allowedTools ?? safeDefaults
  );
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await onToolsChanged(entry, connection, selected);
    } finally {
      setSaving(false);
    }
  }, [connection, entry, onToolsChanged, selected]);

  const handleSave = useCallback(() => {
    save().catch(() => undefined);
  }, [save]);

  const handleToggle = useCallback((name: string, checked: boolean) => {
    setSelected((current) =>
      checked
        ? [...current, name]
        : current.filter((currentName) => currentName !== name)
    );
  }, []);

  if (tools.length === 0) {
    return null;
  }

  return (
    <fieldset className={styles.toolAllowlist} disabled={saving}>
      <legend>Allowed tools</legend>
      <p>Only checked tools can run for every bot using this connection.</p>
      {tools.map((tool: McpToolDescriptor) => (
        <ToolToggle
          checked={selected.includes(tool.name)}
          key={tool.name}
          onToggle={handleToggle}
          tool={tool}
        />
      ))}
      <Button disabled={saving} onClick={handleSave} size="sm">
        {saving ? "Saving…" : "Save tools"}
      </Button>
    </fieldset>
  );
}

function ToolToggle({
  checked,
  onToggle,
  tool,
}: {
  checked: boolean;
  onToggle: (name: string, checked: boolean) => void;
  tool: McpToolDescriptor;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onToggle(tool.name, event.target.checked);
    },
    [onToggle, tool.name]
  );

  return (
    <label>
      <input checked={checked} onChange={handleChange} type="checkbox" />
      <span>
        <strong>{tool.name}</strong>
        <small>{tool.description}</small>
        {tool.ui?.visibility?.length === 1 &&
        tool.ui.visibility[0] === "app" ? (
          <small>Used by the interactive app</small>
        ) : null}
      </span>
    </label>
  );
}

function ProviderSettings({
  entry,
  onSetup,
}: {
  entry: McpCatalogEntry;
  onSetup: (provider: OAuthProvider) => void;
}) {
  const openSettings = useCallback(() => {
    if (entry.oauthProvider) {
      onSetup(entry.oauthProvider);
    }
  }, [entry.oauthProvider, onSetup]);

  if (!entry.oauthProvider || entry.configured === false) {
    return null;
  }

  return (
    <Button
      aria-label={`${entry.name} settings`}
      className={styles.settingsAction}
      onClick={openSettings}
      size="sm"
      variant="ghost"
    >
      <Settings2 aria-hidden />
      Connection settings
    </Button>
  );
}

export function McpIntegrationDetails({
  busy,
  connections,
  entry,
  onConnect,
  onDisconnect,
  onDiscoverTools,
  onReviewUpdate,
  onSetup,
  onToolsChanged,
  removing,
}: Props) {
  return (
    <div className={styles.detailPanel}>
      <header className={styles.hero}>
        <div className={styles.heroIcon}>
          <Image alt="" height={40} src={entry.icon} unoptimized width={40} />
        </div>
        <div className={styles.heroCopy}>
          <div className={styles.heroTitleRow}>
            <h2>{entry.name}</h2>
            {entry.docsUrl ? (
              <a
                aria-label={`${entry.name} documentation`}
                className={styles.docsLink}
                href={entry.docsUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden />
                Documentation
              </a>
            ) : null}
          </div>
          <p>{entry.description}</p>
        </div>
      </header>

      <section
        aria-labelledby="mcp-connections-heading"
        className={styles.section}
      >
        <div className={styles.sectionHeading}>
          <div>
            <h3 id="mcp-connections-heading">Connections</h3>
          </div>
          <span className={styles.sectionHint}>Shared with your bots</span>
        </div>
        <div className={styles.surface}>
          <ConnectionList
            connections={connections}
            entry={entry}
            onDiscoverTools={onDiscoverTools}
            onReviewUpdate={onReviewUpdate}
            onToolsChanged={onToolsChanged}
          />
          <div className={styles.actionRow}>
            <McpIntegrationActions
              busy={busy}
              connections={connections}
              entry={entry}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onSetup={onSetup}
              removing={removing}
            />
            <ProviderSettings entry={entry} onSetup={onSetup} />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="mcp-information-heading"
        className={styles.section}
      >
        <div className={styles.sectionHeading}>
          <div>
            <h3 id="mcp-information-heading">Information</h3>
          </div>
        </div>
        <dl className={styles.infoList}>
          <div className={styles.infoRow}>
            <dt>Category</dt>
            <dd>{getMcpCategory(entry.id)}</dd>
          </div>
          <div className={styles.infoRow}>
            <dt>Sign-in</dt>
            <dd>{signInLabel(entry.auth)}</dd>
          </div>
          <div className={styles.infoRow}>
            <dt>Availability</dt>
            <dd>All your bots</dd>
          </div>
          {entry.docsUrl ? (
            <div className={styles.infoRow}>
              <dt>Documentation</dt>
              <dd className={styles.infoValueWithIcon}>
                <Globe2 aria-hidden />
                <a href={entry.docsUrl} rel="noreferrer" target="_blank">
                  Open docs
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
        {entry.url || entry.oauthScopes ? (
          <details className={styles.technicalDetails}>
            <summary>Technical details</summary>
            <dl className={styles.infoList}>
              <div className={styles.infoRow}>
                <dt>Transport</dt>
                <dd>{transportLabel(entry.transport)}</dd>
              </div>
              {entry.url ? (
                <div className={styles.infoRow}>
                  <dt>Endpoint</dt>
                  <dd className={styles.endpoint}>{entry.url}</dd>
                </div>
              ) : null}
              {entry.oauthScopes ? (
                <div className={styles.infoRow}>
                  <dt>OAuth scopes</dt>
                  <dd className={styles.endpoint}>{entry.oauthScopes}</dd>
                </div>
              ) : null}
            </dl>
          </details>
        ) : null}
      </section>
    </div>
  );
}
