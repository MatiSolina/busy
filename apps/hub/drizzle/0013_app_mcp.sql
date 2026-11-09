-- MCP connections belong to the Busy app, not to an individual bot.
-- Keep bot_id as nullable legacy provenance so this migration preserves every
-- existing grant. New rows leave it NULL and all runtime/store access ignores it.
ALTER TABLE "mcp_connections"
  ALTER COLUMN "bot_id" DROP NOT NULL;

-- The generated constraint name is stable for the schema above. Dropping the
-- foreign key prevents deleting a bot from deleting the app's MCP grants.
ALTER TABLE "mcp_connections"
  DROP CONSTRAINT IF EXISTS "mcp_connections_bot_id_bots_id_fk";
ALTER TABLE "mcp_connections"
  DROP CONSTRAINT IF EXISTS "mcp_connections_bot_id_fkey";

-- Existing deployments could contain one grant per bot for the same catalog.
-- Do not collapse those rows during migration: preserving each encrypted grant
-- avoids silently discarding a user's authorization. The store reuses the first
-- existing row for future adds and the UI can still remove each row by id.
ALTER TABLE "mcp_connections"
  DROP CONSTRAINT IF EXISTS "mcp_connections_bot_id_catalog_id_unique";
ALTER TABLE "mcp_connections"
  DROP CONSTRAINT IF EXISTS "mcp_connections_bot_id_catalog_id_key";

-- Production and local Postgres assign different names to constraints created
-- by the same 0008 migration. Discover the remaining legacy constraints by
-- their columns and relationship instead of relying on a generated name.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint AS c
    WHERE c.conrelid = 'public.mcp_connections'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.bots'::regclass
      AND EXISTS (
        SELECT 1
        FROM unnest(c.conkey) AS column_key(attnum)
        JOIN pg_attribute AS a
          ON a.attrelid = c.conrelid
         AND a.attnum = column_key.attnum
        WHERE a.attname = 'bot_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.mcp_connections DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint AS c
    WHERE c.conrelid = 'public.mcp_connections'::regclass
      AND c.contype = 'u'
      AND (SELECT count(*) FROM unnest(c.conkey)) = 2
      AND EXISTS (
        SELECT 1
        FROM unnest(c.conkey) AS column_key(attnum)
        JOIN pg_attribute AS a
          ON a.attrelid = c.conrelid
         AND a.attnum = column_key.attnum
        WHERE a.attname = 'bot_id'
      )
      AND EXISTS (
        SELECT 1
        FROM unnest(c.conkey) AS column_key(attnum)
        JOIN pg_attribute AS a
          ON a.attrelid = c.conrelid
         AND a.attnum = column_key.attnum
        WHERE a.attname = 'catalog_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.mcp_connections DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;

ALTER TABLE "mcp_connections" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "mcp_connections" FROM anon, authenticated;
