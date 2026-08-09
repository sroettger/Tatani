-- 1. profiles.learning_language
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT 'ja';

-- 2. per-language progress
CREATE TABLE IF NOT EXISTS public.user_language_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  learning_language text NOT NULL,
  level text NOT NULL DEFAULT 'none',
  placement_done boolean NOT NULL DEFAULT false,
  total_words_known integer NOT NULL DEFAULT 0,
  study_streak integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, learning_language)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_language_progress TO authenticated;
GRANT ALL ON public.user_language_progress TO service_role;

ALTER TABLE public.user_language_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own language progress" ON public.user_language_progress
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own language progress" ON public.user_language_progress
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own language progress" ON public.user_language_progress
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users delete own language progress" ON public.user_language_progress
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER user_language_progress_updated
  BEFORE UPDATE ON public.user_language_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- backfill existing japanese progress
INSERT INTO public.user_language_progress (user_id, learning_language, level, placement_done, total_words_known, study_streak)
SELECT p.user_id, 'ja', p.jlpt_level::text, p.placement_done, p.total_words_known, p.study_streak
FROM public.profiles p
ON CONFLICT (user_id, learning_language) DO NOTHING;

-- 3. tag user data with language
ALTER TABLE public.user_word_state   ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT 'ja';
ALTER TABLE public.study_chunks      ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT 'ja';
ALTER TABLE public.study_sessions    ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT 'ja';
ALTER TABLE public.quiz_results      ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT 'ja';
ALTER TABLE public.user_anime        ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT 'ja';
ALTER TABLE public.episode_summaries ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT 'ja';

ALTER TABLE public.user_word_state DROP CONSTRAINT IF EXISTS user_word_state_user_id_word_key;
ALTER TABLE public.user_word_state ADD CONSTRAINT user_word_state_user_word_lang_key UNIQUE (user_id, word, learning_language);

ALTER TABLE public.user_anime DROP CONSTRAINT IF EXISTS user_anime_user_id_anime_id_key;
ALTER TABLE public.user_anime ADD CONSTRAINT user_anime_user_anime_lang_key UNIQUE (user_id, anime_id, learning_language);

ALTER TABLE public.study_chunks DROP CONSTRAINT IF EXISTS study_chunks_user_id_episode_id_chunk_index_key;
ALTER TABLE public.study_chunks ADD CONSTRAINT study_chunks_user_episode_chunk_lang_key UNIQUE (user_id, episode_id, chunk_index, learning_language);

-- 4. per-language episode vocab cache
ALTER TABLE public.episode_vocab_cache ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'ja';
ALTER TABLE public.episode_vocab_cache DROP CONSTRAINT IF EXISTS episode_vocab_cache_episode_id_key;
ALTER TABLE public.episode_vocab_cache ADD CONSTRAINT episode_vocab_cache_episode_language_key UNIQUE (episode_id, language);

-- 5. new users get a japanese progress row
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email,'@',1)),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  INSERT INTO public.user_language_progress (user_id, learning_language) VALUES (NEW.id, 'ja')
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;