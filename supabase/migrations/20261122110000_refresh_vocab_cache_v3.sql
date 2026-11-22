-- Refresh episode_vocab_cache after adding contiguous Katakana compound merging (e.g. インプラント),
-- 2-char non-JLPT Katakana prefix filtering, and non-standalone affix/fragment guards.
DELETE FROM public.episode_vocab_cache;

UPDATE public.episodes
SET processing_status = 'not_processed',
    processing_chunks_done = 0,
    processing_chunks_total = 0
WHERE processing_status IN ('ready', 'failed', 'processing');

-- Remove broken Katakana prefix fragment 'イン' if present in user_word_state
DELETE FROM public.user_word_state WHERE word = 'イン';
