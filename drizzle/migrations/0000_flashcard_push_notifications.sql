CREATE TABLE public.flashcard_push_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, token text NOT NULL UNIQUE,
 enabled boolean NOT NULL DEFAULT true, timezone text NOT NULL DEFAULT 'Asia/Tokyo', start_hour integer NOT NULL DEFAULT 9 CHECK (start_hour BETWEEN 0 AND 23), end_hour integer NOT NULL DEFAULT 21 CHECK (end_hour BETWEEN 0 AND 23), cards_per_day integer NOT NULL DEFAULT 4 CHECK (cards_per_day BETWEEN 1 AND 12), updated_at timestamptz NOT NULL DEFAULT now(), CHECK (end_hour > start_hour), CHECK (cards_per_day <= end_hour-start_hour+1)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcard_push_devices TO service_role;
ALTER TABLE public.flashcard_push_devices ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.flashcard_push_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, device_id uuid NOT NULL REFERENCES public.flashcard_push_devices(id) ON DELETE CASCADE, slot text NOT NULL, learning_language text NOT NULL, word text NOT NULL, reading text, meaning text, example_sentence text, level text, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz, UNIQUE(device_id,slot)
);
GRANT ALL ON public.flashcard_push_deliveries TO service_role;
ALTER TABLE public.flashcard_push_deliveries ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.flashcard_push_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz);
GRANT ALL ON public.flashcard_push_jobs TO service_role;
ALTER TABLE public.flashcard_push_jobs ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.review_flashcard_delivery(delivery_id uuid, owner_id uuid, remembered boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.flashcard_push_deliveries;
BEGIN
 UPDATE public.flashcard_push_deliveries SET reviewed_at=now() WHERE id=delivery_id AND user_id=owner_id AND reviewed_at IS NULL RETURNING * INTO d;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO public.user_word_state(user_id,word,reading,level,learning_language,correct_streak,last_reviewed_at)
 VALUES(owner_id,d.word,d.reading,d.level,d.learning_language,CASE WHEN remembered THEN 1 ELSE 0 END,now())
 ON CONFLICT(user_id,word,learning_language) DO UPDATE SET correct_streak=CASE WHEN remembered THEN user_word_state.correct_streak+1 ELSE 0 END,last_reviewed_at=now();
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.review_flashcard_delivery(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_flashcard_delivery(uuid,uuid,boolean) TO service_role;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;