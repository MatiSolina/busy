import type { McpCatalogEntry } from "@/components/mcp-marketplace";

const categories = [
  { ids: ["gmail", "google-calendar"], name: "Communication" },
  {
    ids: [
      "google-drive",
      "google-docs",
      "google-sheets",
      "google-slides",
      "notion",
      "todoist",
      "linear",
      "atlassian",
    ],
    name: "Productivity",
  },
  {
    ids: [
      "github",
      "vercel",
      "sentry",
      "neon",
      "context7",
      "deepwiki",
      "supabase",
      "posthog",
      "railway",
    ],
    name: "Developer tools",
  },
  { ids: ["stripe", "paypal"], name: "Payments" },
];

export function getMcpCategory(id: string): string {
  return (
    categories.find((category) => category.ids.includes(id))?.name ??
    "Other apps"
  );
}

export function groupMcpCatalog(catalog: McpCatalogEntry[]) {
  const groups = new Map<string, McpCatalogEntry[]>();
  for (const category of categories) {
    groups.set(category.name, []);
  }
  for (const entry of catalog) {
    const category = getMcpCategory(entry.id);
    const entries = groups.get(category) ?? [];
    entries.push(entry);
    groups.set(category, entries);
  }
  return [...groups].filter(([, entries]) => entries.length > 0);
}
