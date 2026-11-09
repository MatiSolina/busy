/**
 * Curated remote MCP servers available to Busy bots.
 *
 * Verification: 2026-11-02. Endpoints and authentication capabilities were
 * checked against each provider's official MCP documentation and the live
 * OAuth protected-resource / authorization-server metadata where available.
 * OAuth entries use Streamable HTTP and advertise OAuth authorization-code
 * + PKCE with Dynamic Client Registration (DCR) or an equivalent discovered
 * registration endpoint. The OAuth implementation must still use discovery;
 * providers can change their authorization-server URLs and scopes.
 *
 * Deliberate exclusions:
 * - Slack is omitted because its MCP server is not a direct DCR integration;
 *   it requires a separately managed Vercel Connect connector.
 * - Token-only or local/stdio servers are omitted from this one-click catalog.
 * - Figma is omitted because its official remote-server guide says only
 *   clients in the Figma MCP catalog may connect and new clients must join a
 *   waitlist: https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/
 */

import { createHash } from "node:crypto";

export const MCP_CATALOG_VERSION = "2026-11-02";

export type McpCatalogLifecycle = "active" | "deprecated";

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

export interface McpCatalogEntry {
  auth: "oauth" | "none";
  description: string;
  docsUrl: string;
  icon: string;
  id: string;
  lifecycle?: McpCatalogLifecycle;
  name: string;
  oauthClientMode?: "cimd";
  oauthProvider?: "github" | "google";
  oauthScopes?: string;
  transport: "http" | "sse";
  url: string;
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    auth: "oauth",
    description: "Repositories, code, issues, pull requests, and reviews.",
    docsUrl:
      "https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md",
    icon: "/mcp-icons/github.svg",
    id: "github",
    name: "GitHub",
    oauthProvider: "github",
    oauthScopes: "repo",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
  },
  {
    auth: "oauth",
    description:
      "Projects, deployments, documentation, and Vercel platform operations.",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
    icon: "/mcp-icons/vercel.svg",
    id: "vercel",
    name: "Vercel",
    oauthClientMode: "cimd",
    oauthScopes: "openid",
    transport: "http",
    url: "https://mcp.vercel.com",
  },
  {
    auth: "oauth",
    description: "Search email, read conversations, and prepare drafts.",
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    icon: "/mcp-icons/gmail.svg",
    id: "gmail",
    name: "Gmail",
    oauthProvider: "google",
    oauthScopes:
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    transport: "http",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
  },
  {
    auth: "oauth",
    description:
      "Find files, read shared documents, and manage bot-created files.",
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    icon: "/mcp-icons/googledrive.svg",
    id: "google-drive",
    name: "Google Drive",
    oauthProvider: "google",
    oauthScopes:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
    transport: "http",
    url: "https://drivemcp.googleapis.com/mcp/v1",
  },
  {
    auth: "oauth",
    description: "Read calendars and events, and check availability.",
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    icon: "/mcp-icons/googlecalendar.svg",
    id: "google-calendar",
    name: "Google Calendar",
    oauthProvider: "google",
    oauthScopes:
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly",
    transport: "http",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
  },
  {
    auth: "oauth",
    description: "Read, create, and edit documents in Google Docs.",
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    icon: "/mcp-icons/googledocs.svg",
    id: "google-docs",
    name: "Google Docs",
    oauthProvider: "google",
    oauthScopes:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents",
    transport: "http",
    url: "https://docsmcp.googleapis.com/mcp/v1",
  },
  {
    auth: "oauth",
    description: "Read, create, and edit spreadsheets and their data.",
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    icon: "/mcp-icons/googlesheets.svg",
    id: "google-sheets",
    name: "Google Sheets",
    oauthProvider: "google",
    oauthScopes:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets",
    transport: "http",
    url: "https://sheetsmcp.googleapis.com/mcp/v1",
  },
  {
    auth: "oauth",
    description: "Read, create, and edit presentations and slides.",
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    icon: "/mcp-icons/googleslides.svg",
    id: "google-slides",
    name: "Google Slides",
    oauthProvider: "google",
    oauthScopes:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/presentations",
    transport: "http",
    url: "https://slidesmcp.googleapis.com/mcp/v1",
  },
  {
    auth: "oauth",
    description: "Issues, projects, cycles, and team workflows.",
    docsUrl: "https://linear.app/docs/mcp",
    icon: "/mcp-icons/linear.svg",
    id: "linear",
    name: "Linear",
    oauthScopes: "read write",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
  },
  {
    auth: "oauth",
    description: "Pages, databases, and workspace content.",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    icon: "/mcp-icons/notion.svg",
    id: "notion",
    name: "Notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
  },
  {
    auth: "oauth",
    description: "Errors, performance, alerts, and project insights.",
    docsUrl: "https://mcp.sentry.dev",
    icon: "/mcp-icons/sentry.svg",
    id: "sentry",
    name: "Sentry",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
  },
  {
    auth: "oauth",
    description: "Jira, Confluence, and Atlassian work management.",
    docsUrl: "https://developer.atlassian.com/cloud/rovo-mcp/",
    icon: "/mcp-icons/atlassian.svg",
    id: "atlassian",
    name: "Atlassian",
    transport: "http",
    url: "https://mcp.atlassian.com/v2/mcp",
  },
  {
    auth: "oauth",
    description: "Neon projects, branches, databases, and SQL.",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
    icon: "/mcp-icons/neon.svg",
    id: "neon",
    name: "Neon",
    transport: "http",
    url: "https://mcp.neon.tech/mcp",
  },
  {
    auth: "none",
    description: "Up-to-date library documentation for coding agents.",
    docsUrl: "https://context7.com/docs/installation",
    icon: "/mcp-icons/context7.png",
    id: "context7",
    name: "Context7",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
  },
  {
    auth: "none",
    description: "AI-generated documentation for public GitHub repositories.",
    docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    icon: "/mcp-icons/deepwiki.png",
    id: "deepwiki",
    name: "DeepWiki",
    transport: "http",
    url: "https://mcp.deepwiki.com/mcp",
  },
  {
    auth: "oauth",
    description: "Tasks, projects, deadlines, and personal productivity.",
    docsUrl: "https://developer.todoist.com/api/v1/",
    icon: "/mcp-icons/todoist.svg",
    id: "todoist",
    name: "Todoist",
    oauthScopes: "data:read_write",
    transport: "http",
    url: "https://ai.todoist.net/mcp",
  },
  {
    auth: "oauth",
    description: "Customers, products, payments, subscriptions, and billing.",
    docsUrl: "https://docs.stripe.com/mcp",
    icon: "/mcp-icons/stripe.svg",
    id: "stripe",
    name: "Stripe",
    oauthScopes: "mcp",
    transport: "http",
    url: "https://mcp.stripe.com",
  },
  {
    auth: "oauth",
    description: "Invoices, payments, orders, and merchant operations.",
    docsUrl: "https://developer.paypal.com/ai-tools/mcp-server",
    icon: "/mcp-icons/paypal.svg",
    id: "paypal",
    name: "PayPal",
    transport: "http",
    url: "https://mcp.paypal.com/http",
  },
  {
    auth: "oauth",
    description: "Projects, databases, SQL, Edge Functions, and storage.",
    docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
    icon: "/mcp-icons/supabase.svg",
    id: "supabase",
    name: "Supabase",
    transport: "http",
    url: "https://mcp.supabase.com/mcp",
  },
  {
    auth: "oauth",
    description: "Analytics, feature flags, experiments, and error tracking.",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    icon: "/mcp-icons/posthog.svg",
    id: "posthog",
    name: "PostHog",
    transport: "http",
    url: "https://mcp.posthog.com/mcp",
  },
  {
    auth: "oauth",
    description: "Projects, services, environments, and deployments.",
    docsUrl: "https://docs.railway.com/ai/mcp-server",
    icon: "/mcp-icons/railway.svg",
    id: "railway",
    name: "Railway",
    oauthScopes: "openid profile email offline_access workspace:member",
    transport: "http",
    url: "https://mcp.railway.com/mcp",
  },
];

/** Tool descriptors are discovered server-side after an explicit connection. */
export function catalogTools(): readonly McpToolDescriptor[] {
  return [];
}

export function catalogDescriptor(entry: McpCatalogEntry) {
  return {
    auth: entry.auth,
    id: entry.id,
    ...(entry.oauthClientMode
      ? { oauthClientMode: entry.oauthClientMode }
      : {}),
    oauthProvider: entry.oauthProvider ?? null,
    oauthScopes: entry.oauthScopes ?? null,
    tools: catalogTools(),
    transport: entry.transport,
    url: entry.url,
    version: MCP_CATALOG_VERSION,
  } as const;
}

export function catalogHash(entry: McpCatalogEntry): string {
  return createHash("sha256")
    .update(JSON.stringify(catalogDescriptor(entry)))
    .digest("hex");
}

export function catalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}
