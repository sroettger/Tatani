ALTER TABLE public.episodes
  ADD COLUMN IF NOT EXISTS processing_chunks_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_chunks_done integer NOT NULL DEFAULT 0;