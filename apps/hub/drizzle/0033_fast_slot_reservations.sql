-- Fast-path slot allocator (docs/fast-path.md). A fast reply reserves its four synthetic event
-- indexes on eve's last line before the model runs; the reservation is consumed in the same
-- transaction that stores the events, released on escalation/failure, and reclaimable once expired.
-- Additive: no existing rows are read or changed.
CREATE TABLE IF NOT EXISTS public.fast_slot_reservations (
  session_id text NOT NULL,
  line integer NOT NULL,
  slot_index integer NOT NULL,
  message_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fast_slot_reservations_session_id_line_slot_index_pk PRIMARY KEY (session_id, line, slot_index)
);
CREATE INDEX IF NOT EXISTS fast_slot_reservations_message_idx
  ON public.fast_slot_reservations (message_id);
ALTER TABLE public.fast_slot_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fast_slot_reservations FROM PUBLIC, anon, authenticated;
