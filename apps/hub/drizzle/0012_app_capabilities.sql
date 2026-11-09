-- Capabilities belong to the Busy app and are shared by every bot. Keep the
-- old table for one release so existing bot deployments can still be rolled
-- back, while copying its reviewed rows into the global catalog.
CREATE TABLE IF NOT EXISTS public.app_capabilities (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL CHECK ("kind" IN ('skill', 'plugin')),
  "name" text NOT NULL,
  "description" text NOT NULL,
  "version" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "skills" jsonb NOT NULL,
  "origin" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("kind", "name")
);

ALTER TABLE public.app_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_capabilities FROM anon, authenticated;

-- Record source rows that have already been copied. This makes rerunning the
-- additive migration safe after an operator removes a global capability.
CREATE TABLE IF NOT EXISTS public.app_capability_migrations (
  "source_id" uuid PRIMARY KEY,
  "migrated_at" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_capability_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_capability_migrations FROM anon, authenticated;

-- Keep every prior installation. If two bots used the same name, the first
-- row keeps it and later rows receive a deterministic UUID suffix. The loop
-- also checks against names already in the global catalog, so no row is
-- silently dropped by a uniqueness conflict.
DO $$
DECLARE
  source_row RECORD;
  candidate text;
  suffix text;
  counter integer;
  enabled_count bigint;
  enabled_skills bigint;
  enabled_bytes bigint;
BEGIN
  FOR source_row IN
    SELECT bc.*
    FROM public.bot_capabilities bc
    LEFT JOIN public.app_capability_migrations marker ON marker.source_id = bc.id
    WHERE marker.source_id IS NULL
    ORDER BY bc.created_at, bc.id
  LOOP
    candidate := source_row.name;
    IF EXISTS (
      SELECT 1 FROM public.app_capabilities
      WHERE kind = source_row.kind AND name = candidate
    ) THEN
      suffix := '-' || replace(source_row.id::text, '-', '');
      candidate := left(source_row.name, 64 - length(suffix)) || suffix;
      counter := 0;
      WHILE EXISTS (
        SELECT 1 FROM public.app_capabilities
        WHERE kind = source_row.kind AND name = candidate
      ) LOOP
        counter := counter + 1;
        suffix := '-' || replace(source_row.id::text, '-', '') || '-' || counter::text;
        candidate := left(source_row.name, 64 - length(suffix)) || suffix;
      END LOOP;
    END IF;

    INSERT INTO public.app_capabilities
      (id, kind, name, description, version, enabled, skills, origin, created_at, updated_at)
    VALUES
      (source_row.id, source_row.kind, candidate, source_row.description, source_row.version,
       source_row.enabled, source_row.skills, source_row.origin, source_row.created_at, source_row.updated_at);
    INSERT INTO public.app_capability_migrations (source_id) VALUES (source_row.id);
  END LOOP;

  -- The runtime prefixes every skill name with 19 bytes. Add that prefix and
  -- a small JSON envelope margin so this preflight cannot undercount payload
  -- size even though the stored JSONB has not yet been serialized by Eve.
  SELECT count(*) INTO enabled_count
  FROM public.app_capabilities
  WHERE enabled;
  SELECT coalesce(sum(jsonb_array_length(skills)), 0) INTO enabled_skills
  FROM public.app_capabilities
  WHERE enabled;
  SELECT coalesce(sum(octet_length(convert_to(jsonb_build_object('skills', skills)::text, 'UTF8'))), 0)
    + (coalesce(sum(jsonb_array_length(skills)), 0) * 19) + 20
    INTO enabled_bytes
  FROM public.app_capabilities
  WHERE enabled;

  IF enabled_count > 32 THEN
    RAISE EXCEPTION 'app_capabilities migration needs review: % enabled capabilities exceeds the shared limit of 32', enabled_count;
  END IF;
  IF enabled_skills > 256 THEN
    RAISE EXCEPTION 'app_capabilities migration needs review: % enabled skills exceeds the shared limit of 256', enabled_skills;
  END IF;
  IF enabled_bytes > 2097152 THEN
    RAISE EXCEPTION 'app_capabilities migration needs review: enabled content exceeds the shared limit of 2097152 bytes';
  END IF;
END $$;
