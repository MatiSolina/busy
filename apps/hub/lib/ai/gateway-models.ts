import { MODELS } from "../bots/models";

const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

export interface GatewayModel {
  fast: boolean;
  id: string;
  label: string;
}

interface CatalogRow {
  id?: unknown;
  name?: unknown;
  pricing?: { service_tiers?: { priority?: unknown } };
  tags?: unknown;
  type?: unknown;
}

/**
 * Every AI Gateway language model that can call tools (bots need them), featured ones first.
 * Fast = the catalog prices a `priority` tier. Falls back to the curated list if the catalog is down.
 */
export async function listGatewayModels(): Promise<GatewayModel[]> {
  const featured: GatewayModel[] = MODELS.map(({ fast, id, label }) => ({
    fast,
    id,
    label,
  }));
  let rows: CatalogRow[];
  try {
    const response = await fetch(GATEWAY_CATALOG_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return featured;
    }
    rows = ((await response.json()) as { data?: CatalogRow[] }).data ?? [];
  } catch {
    return featured;
  }
  const seen = new Set(featured.map((model) => model.id));
  const rest = rows
    .filter(
      (row): row is CatalogRow & { id: string } =>
        row.type === "language" &&
        typeof row.id === "string" &&
        Array.isArray(row.tags) &&
        row.tags.includes("tool-use") &&
        !seen.has(row.id)
    )
    .map((row) => ({
      fast: Boolean(row.pricing?.service_tiers?.priority),
      id: row.id,
      label: typeof row.name === "string" ? row.name : row.id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...featured, ...rest];
}

export async function gatewaySupportsFast(model: string): Promise<boolean> {
  return (await listGatewayModels()).some(
    (entry) => entry.id === model && entry.fast
  );
}
