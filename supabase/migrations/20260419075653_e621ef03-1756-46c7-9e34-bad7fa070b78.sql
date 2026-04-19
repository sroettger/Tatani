-- New enum for word preference (how the user wants to study each word)
CREATE TYPE public.word_preference AS ENUM ('study', 'kanji_only', 'skip');

-- Add preference column to user_word_state
ALTER TABLE public.user_word_state
  ADD COLUMN preference public.word_preference NOT NULL DEFAULT 'study';

-- study_chunks: ordered chunks of words per user per episode
CREATE TABLE public.study_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  word_count integer NOT NULL DEFAULT 0,
  studied_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, episode_id, chunk_index)
);

CREATE INDEX idx_study_chunks_user_episode ON public.study_chunks(user_id, episode_id);

ALTER TABLE public.study_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own chunks" ON public.study_chunks
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own chunks" ON public.study_chunks
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own chunks" ON public.study_chunks
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own chunks" ON public.study_chunks
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_study_chunks_updated_at
  BEFORE UPDATE ON public.study_chunks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- study_chunk_words: words inside each chunk, ordered
CREATE TABLE public.study_chunk_words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id uuid NOT NULL REFERENCES public.study_chunks(id) ON DELETE CASCADE,
  word text NOT NULL,
  reading text,
  meaning text,
  jlpt_level public.jlpt_level,
  part_of_speech text,
  example_sentence_jp text,
  example_sentence_en text,
  position integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_study_chunk_words_chunk ON public.study_chunk_words(chunk_id, position);

ALTER TABLE public.study_chunk_words ENABLE ROW LEVEL SECURITY;

-- Users access chunk words through chunk ownership
CREATE POLICY "Users view own chunk words" ON public.study_chunk_words
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.study_chunks c WHERE c.id = chunk_id AND c.user_id = auth.uid())
  );
CREATE POLICY "Users insert own chunk words" ON public.study_chunk_words
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.study_chunks c WHERE c.id = chunk_id AND c.user_id = auth.uid())
  );
CREATE POLICY "Users update own chunk words" ON public.study_chunk_words
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.study_chunks c WHERE c.id = chunk_id AND c.user_id = auth.uid())
  );
CREATE POLICY "Users delete own chunk words" ON public.study_chunk_words
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.study_chunks c WHERE c.id = chunk_id AND c.user_id = auth.uid())
  );

-- Link study sessions to chunks
ALTER TABLE public.study_sessions
  ADD COLUMN chunk_id uuid REFERENCES public.study_chunks(id) ON DELETE SET NULL;

CREATE INDEX idx_study_sessions_chunk ON public.study_sessions(chunk_id);