-- Hub navigation sections. A bot has at most one section through its
-- membership primary key; deleting either side removes only the membership.
CREATE TABLE IF NOT EXISTS public.bot_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bot_sections_name_ci_idx
  ON public.bot_sections (lower(name));

CREATE TABLE IF NOT EXISTS public.bot_section_memberships (
  bot_id uuid PRIMARY KEY REFERENCES public.bots(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.bot_sections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bot_section_memberships_section_idx
  ON public.bot_section_memberships (section_id);

ALTER TABLE public.bot_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_section_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_sections, public.bot_section_memberships FROM PUBLIC, anon, authenticated;
