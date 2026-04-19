DELETE FROM public.episode_vocab_cache;
UPDATE public.episodes SET processing_status = 'not_processed', processing_chunks_done = 0, processing_chunks_total = 0;