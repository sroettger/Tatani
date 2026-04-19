ALTER TABLE public.user_word_state
  ADD COLUMN IF NOT EXISTS known_source text,
  ADD COLUMN IF NOT EXISTS srs_level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS srs_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS marked_known_at timestamptz;

ALTER TABLE public.user_word_state
  DROP CONSTRAINT IF EXISTS user_word_state_known_source_check;

ALTER TABLE public.user_word_state
  ADD CONSTRAINT user_word_state_known_source_check
  CHECK (known_source IS NULL OR known_source IN ('prior', 'learned'));

CREATE INDEX IF NOT EXISTS idx_user_word_state_due
  ON public.user_word_state (user_id, srs_due_at)
  WHERE known_source = 'learned';