-- Ensure standard Supabase role privileges on all public schema objects when migrations
-- are applied via the Management API (/database/query runs as supabase_admin rather than postgres,
-- so postgres default privilege hooks do not fire automatically).

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON TABLE
  public.profiles,
  public.user_roles,
  public.user_language_progress,
  public.anime,
  public.seasons,
  public.episodes,
  public.user_anime,
  public.episode_vocab_cache,
  public.user_word_state,
  public.subtitles,
  public.study_chunks,
  public.study_chunk_words,
  public.study_sessions,
  public.quiz_results,
  public.episode_summaries
TO postgres, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.profiles,
  public.user_roles,
  public.user_language_progress,
  public.anime,
  public.seasons,
  public.episodes,
  public.user_anime,
  public.episode_vocab_cache,
  public.user_word_state,
  public.subtitles,
  public.study_chunks,
  public.study_chunk_words,
  public.study_sessions,
  public.quiz_results,
  public.episode_summaries
TO authenticated;

GRANT SELECT ON TABLE
  public.anime,
  public.seasons,
  public.episodes,
  public.episode_vocab_cache
TO anon;

-- Keep flashcard push device tokens, deliveries, and queue jobs server-side only (service_role)
GRANT ALL ON TABLE
  public.flashcard_push_devices,
  public.flashcard_push_deliveries,
  public.flashcard_push_jobs
TO postgres, service_role;

GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO postgres, anon, authenticated, service_role;

-- Backfill profile / role / language progress rows for any users created prior to this migration
INSERT INTO public.profiles (user_id, display_name, avatar_url)
SELECT
  id,
  COALESCE(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)),
  raw_user_meta_data->>'avatar_url'
FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.user_roles (user_id, role)
SELECT id, 'user'::public.app_role
FROM auth.users
ON CONFLICT (user_id, role) DO NOTHING;

INSERT INTO public.user_language_progress (user_id, learning_language)
SELECT id, 'ja'
FROM auth.users
ON CONFLICT (user_id, learning_language) DO NOTHING;

NOTIFY pgrst, 'reload schema';
