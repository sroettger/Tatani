-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('admin', 'user');
CREATE TYPE public.jlpt_level AS ENUM ('N5', 'N4', 'N3', 'N2', 'N1', 'none');
CREATE TYPE public.word_state AS ENUM ('unknown', 'learning', 'known');
CREATE TYPE public.episode_status AS ENUM ('not_processed', 'processing', 'ready', 'failed');
CREATE TYPE public.subtitle_source AS ENUM ('auto', 'upload');
CREATE TYPE public.study_mode AS ENUM ('review', 'quiz');
CREATE TYPE public.quiz_type AS ENUM ('jp_to_meaning', 'meaning_to_jp', 'fill_blank');

-- ============ UTILITY ============
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  jlpt_level public.jlpt_level NOT NULL DEFAULT 'none',
  placement_done BOOLEAN NOT NULL DEFAULT FALSE,
  total_words_known INTEGER NOT NULL DEFAULT 0,
  study_streak INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email,'@',1)),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE POLICY "Users view own roles" ON public.user_roles FOR SELECT USING (auth.uid() = user_id);

-- Trigger for new users (after user_roles exists)
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ ANIME CATALOG (shared, read-only to users) ============
CREATE TABLE public.anime (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anilist_id INTEGER UNIQUE,
  mal_id INTEGER UNIQUE,
  title_jp TEXT,
  title_en TEXT,
  title_romaji TEXT NOT NULL,
  cover_url TEXT,
  year INTEGER,
  season_count INTEGER NOT NULL DEFAULT 1,
  episode_count INTEGER NOT NULL DEFAULT 0,
  synopsis TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.anime ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated can view anime" ON public.anime FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage anime" ON public.anime FOR ALL USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER anime_updated BEFORE UPDATE ON public.anime FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anime_id UUID NOT NULL REFERENCES public.anime(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,
  title TEXT,
  episode_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (anime_id, season_number)
);
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated can view seasons" ON public.seasons FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage seasons" ON public.seasons FOR ALL USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  episode_number INTEGER NOT NULL,
  title_jp TEXT,
  title_en TEXT,
  processing_status public.episode_status NOT NULL DEFAULT 'not_processed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_id, episode_number)
);
ALTER TABLE public.episodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated can view episodes" ON public.episodes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage episodes" ON public.episodes FOR ALL USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER episodes_updated BEFORE UPDATE ON public.episodes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ USER ANIME (per-user library) ============
CREATE TABLE public.user_anime (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  anime_id UUID NOT NULL REFERENCES public.anime(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, anime_id)
);
ALTER TABLE public.user_anime ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own library" ON public.user_anime FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users add to own library" ON public.user_anime FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own library" ON public.user_anime FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users remove from own library" ON public.user_anime FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_user_anime_user ON public.user_anime(user_id, added_at DESC);

-- ============ EPISODE VOCAB CACHE (shared AI extraction) ============
CREATE TABLE public.episode_vocab_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL UNIQUE REFERENCES public.episodes(id) ON DELETE CASCADE,
  vocab JSONB NOT NULL DEFAULT '[]'::jsonb,
  sentences JSONB NOT NULL DEFAULT '[]'::jsonb,
  grammar JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.episode_vocab_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated views cache" ON public.episode_vocab_cache FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage cache" ON public.episode_vocab_cache FOR ALL USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER vocab_cache_updated BEFORE UPDATE ON public.episode_vocab_cache FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ USER WORD STATE ============
CREATE TABLE public.user_word_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  reading TEXT,
  state public.word_state NOT NULL DEFAULT 'unknown',
  correct_streak INTEGER NOT NULL DEFAULT 0,
  jlpt_level public.jlpt_level,
  last_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, word)
);
ALTER TABLE public.user_word_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own words" ON public.user_word_state FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own words" ON public.user_word_state FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own words" ON public.user_word_state FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own words" ON public.user_word_state FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_user_word_state_user_state ON public.user_word_state(user_id, state);
CREATE TRIGGER user_word_updated BEFORE UPDATE ON public.user_word_state FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ SUBTITLES (metadata) ============
CREATE TABLE public.subtitles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES public.episodes(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source public.subtitle_source NOT NULL,
  language TEXT NOT NULL DEFAULT 'ja',
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.subtitles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated view subtitle metadata" ON public.subtitles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users insert own subtitle metadata" ON public.subtitles FOR INSERT WITH CHECK (auth.uid() = uploaded_by OR uploaded_by IS NULL);
CREATE POLICY "Admins manage subtitles" ON public.subtitles FOR ALL USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- ============ STUDY SESSIONS + QUIZ RESULTS ============
CREATE TABLE public.study_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE SET NULL,
  mode public.study_mode NOT NULL,
  words_studied INTEGER NOT NULL DEFAULT 0,
  words_mastered INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
ALTER TABLE public.study_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own sessions" ON public.study_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own sessions" ON public.study_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own sessions" ON public.study_sessions FOR UPDATE USING (auth.uid() = user_id);

CREATE TABLE public.quiz_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.study_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  was_correct BOOLEAN NOT NULL,
  quiz_kind public.quiz_type NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.quiz_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own quiz results" ON public.quiz_results FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own quiz results" ON public.quiz_results FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============ STORAGE BUCKET ============
INSERT INTO storage.buckets (id, name, public) VALUES ('subtitles', 'subtitles', false);

CREATE POLICY "Auth read subtitles" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'subtitles');
CREATE POLICY "Users upload to own folder in subtitles" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'subtitles' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users update own subtitle files" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'subtitles' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users delete own subtitle files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'subtitles' AND auth.uid()::text = (storage.foldername(name))[1]);