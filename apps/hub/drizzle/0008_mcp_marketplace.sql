CREATE TABLE IF NOT EXISTS "mcp_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bot_id" uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "catalog_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'connected', 'error')),
  "error" text,
  "oauth_data" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("bot_id", "catalog_id")
);

-- The hub accesses this table through its server-side Postgres connection only.
ALTER TABLE "mcp_connections" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "mcp_connections" FROM anon, authenticated;
