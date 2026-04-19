CREATE TABLE public.episode_summaries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  episode_id UUID NOT NULL,
  summary_jp TEXT NOT NULL,
  summary_en TEXT NOT NULL,
  used_words JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, episode_id)
);

ALTER TABLE public.episode_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own episode summaries"
ON public.episode_summaries FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users insert own episode summaries"
ON public.episode_summaries FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own episode summaries"
ON public.episode_summaries FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users delete own episode summaries"
ON public.episode_summaries FOR DELETE
USING (auth.uid() = user_id);

CREATE TRIGGER update_episode_summaries_updated_at
BEFORE UPDATE ON public.episode_summaries
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_episode_summaries_user_episode ON public.episode_summaries(user_id, episode_id);