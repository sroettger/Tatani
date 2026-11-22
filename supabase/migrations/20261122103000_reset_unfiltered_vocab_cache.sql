-- Clear stale vocabulary caches generated before proper-noun filtering and season-dispersion
-- ranking were introduced, while keeping all user SRS states (user_word_state) intact.
DELETE FROM public.episode_vocab_cache;

UPDATE public.episodes
SET processing_status = 'not_processed',
    processing_chunks_done = 0,
    processing_chunks_total = 0
WHERE processing_status IN ('ready', 'failed', 'processing');
