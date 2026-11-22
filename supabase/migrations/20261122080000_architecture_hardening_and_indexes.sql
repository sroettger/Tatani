-- Architecture hardening, SRS off-by-one fix, cascading foreign keys, privilege tightening, and performance indexes.

-- 1. Add 'learn_context' to study_mode enum for contextual encoding sessions
ALTER TYPE public.study_mode ADD VALUE IF NOT EXISTS 'learn_context';

-- 2. Scope episode_summaries uniqueness and index by learning_language
DELETE FROM public.episode_summaries a
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, episode_id, learning_language
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS rn
  FROM public.episode_summaries
) dup
WHERE a.id = dup.id AND dup.rn > 1;

ALTER TABLE public.episode_summaries
  DROP CONSTRAINT IF EXISTS episode_summaries_user_id_episode_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'episode_summaries_user_episode_lang_key'
  ) THEN
    ALTER TABLE public.episode_summaries
      ADD CONSTRAINT episode_summaries_user_episode_lang_key
      UNIQUE (user_id, episode_id, learning_language);
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_episode_summaries_user_episode;
CREATE INDEX IF NOT EXISTS idx_episode_summaries_user_episode_lang
  ON public.episode_summaries(user_id, episode_id, learning_language);

-- 3. Fix review_flashcard_delivery Leitner SRS graduation/lapse intervals, metadata backfill, and prior-known guard
CREATE OR REPLACE FUNCTION public.review_flashcard_delivery(delivery_id uuid, owner_id uuid, remembered boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.flashcard_push_deliveries;
  intervals integer[] := ARRAY[1, 3, 7, 14, 30, 60, 120, 240, 480];
BEGIN
  UPDATE public.flashcard_push_deliveries
  SET reviewed_at = now()
  WHERE id = delivery_id
    AND user_id = owner_id
    AND reviewed_at IS NULL
    AND (quiz_options IS NULL OR quiz_selected_index IS NOT NULL)
  RETURNING * INTO d;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.user_word_state(
    user_id, word, reading, level, learning_language,
    correct_streak, last_reviewed_at, state, known_source, srs_level, srs_due_at, marked_known_at
  )
  VALUES (
    owner_id, d.word, d.reading, d.level, d.learning_language,
    CASE WHEN remembered THEN 1 ELSE 0 END,
    now(),
    CASE WHEN remembered THEN 'known'::public.word_state ELSE 'learning'::public.word_state END,
    'learned',
    0,
    now() + interval '1 day',
    CASE WHEN remembered THEN now() ELSE NULL END
  )
  ON CONFLICT (user_id, word, learning_language) DO UPDATE SET
    reading = COALESCE(EXCLUDED.reading, user_word_state.reading),
    level = COALESCE(EXCLUDED.level, user_word_state.level),
    correct_streak = CASE WHEN remembered THEN user_word_state.correct_streak + 1 ELSE 0 END,
    last_reviewed_at = now(),
    state = CASE WHEN remembered THEN 'known'::public.word_state ELSE 'learning'::public.word_state END,
    known_source = 'learned',
    srs_level = CASE
      WHEN NOT remembered
        OR user_word_state.srs_due_at IS NULL
        OR user_word_state.state = 'learning'::public.word_state
        OR user_word_state.state <> 'known'::public.word_state
      THEN 0
      ELSE LEAST(GREATEST(user_word_state.srs_level, 0) + 1, 8)
    END,
    srs_due_at = CASE
      WHEN NOT remembered
        OR user_word_state.srs_due_at IS NULL
        OR user_word_state.state = 'learning'::public.word_state
        OR user_word_state.state <> 'known'::public.word_state
      THEN now() + interval '1 day'
      ELSE now() + make_interval(
        days => intervals[LEAST(GREATEST(user_word_state.srs_level, 0) + 1, 8) + 1]
      )
    END,
    marked_known_at = COALESCE(
      user_word_state.marked_known_at,
      CASE WHEN remembered THEN now() ELSE NULL END
    )
  WHERE user_word_state.known_source IS DISTINCT FROM 'prior';

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.review_flashcard_delivery(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_flashcard_delivery(uuid, uuid, boolean) TO service_role;

-- 4. Clean up orphaned rows and idempotently add ON DELETE CASCADE foreign keys
DELETE FROM public.flashcard_push_devices d
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = d.user_id);

DELETE FROM public.flashcard_push_deliveries d
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = d.user_id);

DELETE FROM public.study_chunks c
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = c.user_id);

DELETE FROM public.study_chunks c
WHERE NOT EXISTS (SELECT 1 FROM public.episodes e WHERE e.id = c.episode_id);

DELETE FROM public.episode_summaries s
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id);

DELETE FROM public.episode_summaries s
WHERE NOT EXISTS (SELECT 1 FROM public.episodes e WHERE e.id = s.episode_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flashcard_push_devices_user_id_fkey'
  ) THEN
    ALTER TABLE public.flashcard_push_devices
      ADD CONSTRAINT flashcard_push_devices_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flashcard_push_deliveries_user_id_fkey'
  ) THEN
    ALTER TABLE public.flashcard_push_deliveries
      ADD CONSTRAINT flashcard_push_deliveries_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'study_chunks_user_id_fkey'
  ) THEN
    ALTER TABLE public.study_chunks
      ADD CONSTRAINT study_chunks_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'study_chunks_episode_id_fkey'
  ) THEN
    ALTER TABLE public.study_chunks
      ADD CONSTRAINT study_chunks_episode_id_fkey
      FOREIGN KEY (episode_id) REFERENCES public.episodes(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'episode_summaries_user_id_fkey'
  ) THEN
    ALTER TABLE public.episode_summaries
      ADD CONSTRAINT episode_summaries_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'episode_summaries_episode_id_fkey'
  ) THEN
    ALTER TABLE public.episode_summaries
      ADD CONSTRAINT episode_summaries_episode_id_fkey
      FOREIGN KEY (episode_id) REFERENCES public.episodes(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 5. Tighten table privileges & RLS insert policies
REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.user_roles,
  public.anime,
  public.seasons,
  public.episodes,
  public.episode_vocab_cache
FROM authenticated, anon;

GRANT SELECT ON TABLE
  public.user_roles,
  public.anime,
  public.seasons,
  public.episodes,
  public.episode_vocab_cache
TO authenticated;

GRANT ALL ON TABLE
  public.user_roles,
  public.anime,
  public.seasons,
  public.episodes,
  public.episode_vocab_cache
TO postgres, service_role;

DROP POLICY IF EXISTS "Users insert own subtitle metadata" ON public.subtitles;
CREATE POLICY "Users insert own subtitle metadata"
  ON public.subtitles
  FOR INSERT
  WITH CHECK (auth.uid() = uploaded_by);

DROP POLICY IF EXISTS "Users insert own quiz results" ON public.quiz_results;
CREATE POLICY "Users insert own quiz results"
  ON public.quiz_results
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.study_sessions s
      WHERE s.id = session_id
        AND s.user_id = auth.uid()
    )
  );

-- 6. Add missing performance indexes
CREATE INDEX IF NOT EXISTS idx_subtitles_episode_lang
  ON public.subtitles(episode_id, language);

CREATE INDEX IF NOT EXISTS idx_study_sessions_user_lang
  ON public.study_sessions(user_id, learning_language);

CREATE INDEX IF NOT EXISTS idx_study_sessions_episode
  ON public.study_sessions(episode_id);

CREATE INDEX IF NOT EXISTS idx_quiz_results_user_lang
  ON public.quiz_results(user_id, learning_language);

CREATE INDEX IF NOT EXISTS idx_quiz_results_session
  ON public.quiz_results(session_id);

CREATE INDEX IF NOT EXISTS idx_flashcard_deliveries_user_lang_created
  ON public.flashcard_push_deliveries(user_id, learning_language, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_flashcard_devices_user
  ON public.flashcard_push_devices(user_id);

CREATE INDEX IF NOT EXISTS idx_flashcard_jobs_created
  ON public.flashcard_push_jobs(created_at);

CREATE INDEX IF NOT EXISTS idx_user_word_state_user_lang_state
  ON public.user_word_state(user_id, learning_language, state);

DROP INDEX IF EXISTS public.idx_user_word_state_due;
CREATE INDEX IF NOT EXISTS idx_user_word_state_due
  ON public.user_word_state(user_id, learning_language, srs_due_at)
  WHERE srs_due_at IS NOT NULL AND known_source IS DISTINCT FROM 'prior';

NOTIFY pgrst, 'reload schema';
